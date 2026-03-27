import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AskUserRequest, AskUserResponse, AuditEntry, PortInfo, QuestionClass } from './types.js';
import { classifyQuestion } from './classifier.js';
import { RateLimiter } from './rate-limiter.js';
import { AuditLog } from './audit.js';
import { getQuestionWebviewHtml } from './webview.js';

let server: http.Server | undefined;
let auditLog: AuditLog;
let rateLimiter: RateLimiter;
let authToken: string;

export function activate(context: vscode.ExtensionContext) {
  // Initialize security components
  auditLog = new AuditLog(context.globalStorageUri.fsPath);
  rateLimiter = new RateLimiter({
    perMinute: 3,
    perSession: 20,
    rejectCooldownMs: 10_000,
  });
  authToken = crypto.randomBytes(32).toString('hex');

  // Start the local HTTP bridge
  startBridge(context);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agentCheckpoint.showAuditLog', () => showAuditLog()),
    vscode.commands.registerCommand('agentCheckpoint.verifyAuditLog', () => verifyAuditLog()),
    vscode.commands.registerCommand('agentCheckpoint.resetSession', () => {
      rateLimiter.reset();
      vscode.window.showInformationMessage('Agent Checkpoint: Session counters reset.');
    }),
  );

  vscode.window.showInformationMessage('Agent Checkpoint active.');
}

export function deactivate() {
  server?.close();
  cleanupPortFile();
}

// ─── HTTP Bridge ────────────────────────────────────────────────────────────

function startBridge(context: vscode.ExtensionContext) {
  server = http.createServer(async (req, res) => {
    // Only accept POST to /ask
    if (req.method !== 'POST' || req.url !== '/ask') {
      res.writeHead(404);
      res.end();
      return;
    }

    // Authenticate — token must match
    const providedToken = req.headers['x-checkpoint-token'];
    if (providedToken !== authToken) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }

    try {
      const body = await readBody(req);
      const request: AskUserRequest = JSON.parse(body);
      const response = await handleQuestion(request);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // Listen on random available port, localhost only
  server.listen(0, '127.0.0.1', () => {
    const addr = server!.address();
    if (addr && typeof addr === 'object') {
      writePortFile(addr.port);
      console.log(`Agent Checkpoint bridge on port ${addr.port}`);
    }
  });

  server.on('error', (err) => {
    vscode.window.showErrorMessage(`Agent Checkpoint bridge error: ${err.message}`);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 64 * 1024; // 64KB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ─── Port File (Discovery) ──────────────────────────────────────────────────

function getPortFilePath(): string {
  const dir = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
    '.agent-checkpoint',
  );
  return path.join(dir, 'bridge.json');
}

function writePortFile(port: number) {
  const filePath = getPortFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const info: PortInfo = { port, token: authToken, pid: process.pid };
  fs.writeFileSync(filePath, JSON.stringify(info), { mode: 0o600 });
}

function cleanupPortFile() {
  try {
    fs.unlinkSync(getPortFilePath());
  } catch {
    // ignore
  }
}

// ─── Question Handling (all security lives here) ────────────────────────────

async function handleQuestion(request: AskUserRequest): Promise<AskUserResponse> {
  const classification = classifyQuestion(request);
  const agentId = request.agentId ?? 'unknown';
  const toolChain = request.toolChain ?? [];

  // Layer 1: Classification gate
  if (classification === 'sensitive') {
    const response = blocked('Question involves sensitive data — agent must instruct user directly');
    logAudit(request, classification, response);
    return response;
  }

  // Layer 2: Rate limiter
  const rateLimitReason = rateLimiter.check(request.question);
  if (rateLimitReason) {
    const response = blocked(rateLimitReason);
    logAudit(request, classification, response);
    return response;
  }

  // Layer 3: Show UI with provenance
  rateLimiter.record(request.question);
  const response = await showQuestionUI(request, classification, agentId, toolChain);

  // Track rejections for cooldown
  if (response.selectedOptionId === 'rejected') {
    rateLimiter.recordRejection();
  }

  logAudit(request, classification, response);
  return response;
}

function blocked(reason: string): AskUserResponse {
  return { selectedOptionId: 'blocked', selectedLabel: '', blocked: true, blockReason: reason };
}

function logAudit(
  request: AskUserRequest,
  classification: QuestionClass,
  response: AskUserResponse,
) {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    questionId: request.questionId,
    agentId: request.agentId ?? 'unknown',
    question: request.question,
    classification,
    selectedOptionId: response.selectedOptionId,
    selectedLabel: response.selectedLabel,
    blocked: response.blocked,
    blockReason: response.blockReason,
    toolChain: request.toolChain ?? [],
  };
  auditLog.write(entry);
}

// ─── VS Code UI ─────────────────────────────────────────────────────────────

/**
 * Route the question to the best UI surface:
 * - Free-text → input box (informational only; blocked for sensitive)
 * - All option-based questions → QuickPick (vertical list, grabs focus,
 *   number-key filtering via 1./2./3. prefixes, supports long labels)
 */
async function showQuestionUI(
  request: AskUserRequest,
  classification: QuestionClass,
  agentId: string,
  toolChain: string[],
): Promise<AskUserResponse> {
  if (request.allowFreeText) {
    return showFreeTextUI(request, agentId);
  }
  return showQuickPickUI(request, classification, agentId, toolChain);
}

/**
 * QuickPick — vertical list, immediate keyboard focus.
 * Type a digit to filter to that option, Enter to confirm.
 * Permission-class questions show the classification badge in the title.
 */
async function showQuickPickUI(
  request: AskUserRequest,
  classification: QuestionClass,
  agentId: string,
  toolChain: string[],
): Promise<AskUserResponse> {
  const stats = rateLimiter.stats();
  const chainStr = toolChain.length > 0 ? toolChain.join(' → ') : 'direct';
  const classBadge = classification === 'permission' ? '$(shield) PERMISSION | ' : '';

  const items: vscode.QuickPickItem[] = request.options.map((opt, i) => ({
    label: `${i + 1}. ${opt.label}`,
    description: opt.description ?? '',
    detail: opt.id,
  }));
  items.push({
    label: '$(close) Reject this question',
    description: '',
    detail: 'rejected',
  });

  const provenance = `${classBadge}Agent: ${agentId}  |  ${chainStr}  |  Q#${stats.sessionCount}`;

  const selected = await vscode.window.showQuickPick(items, {
    title: `Agent Question [${provenance}]`,
    placeHolder: request.question,
    ignoreFocusOut: true,
  });

  if (!selected || selected.detail === 'rejected') {
    return { selectedOptionId: 'rejected', selectedLabel: 'Rejected', blocked: false };
  }

  const matched = request.options.find(o => o.id === selected.detail);
  return {
    selectedOptionId: matched?.id ?? selected.detail ?? 'unknown',
    selectedLabel: matched?.label ?? selected.label,
    blocked: false,
  };
}

/**
 * Free-text input box. Only allowed for informational questions —
 * sensitive questions are blocked before reaching this point.
 * Response length is capped at 500 chars to limit exfiltration surface.
 */
async function showFreeTextUI(
  request: AskUserRequest,
  agentId: string,
): Promise<AskUserResponse> {
  const stats = rateLimiter.stats();
  const MAX_LENGTH = 500;

  const value = await vscode.window.showInputBox({
    title: `[${agentId} · Q#${stats.sessionCount}] ${request.question}`,
    placeHolder: request.freeTextPlaceholder ?? 'Type your answer...',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (v.length > MAX_LENGTH) {
        return `Response too long (${v.length}/${MAX_LENGTH} chars)`;
      }
      return null;
    },
  });

  if (value === undefined) {
    return { selectedOptionId: 'rejected', selectedLabel: 'Rejected (dismissed)', blocked: false };
  }

  return {
    selectedOptionId: 'free_text',
    selectedLabel: value,
    blocked: false,
  };
}

/** Full webview panel for permission-class questions */
function showWebviewUI(
  request: AskUserRequest,
  classification: QuestionClass,
  agentId: string,
  toolChain: string[],
): Promise<AskUserResponse> {
  const stats = rateLimiter.stats();

  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'agentCheckpointQuestion',
      `Agent Question — ${classification.toUpperCase()}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false },
    );

    let resolved = false;
    const finish = (response: AskUserResponse) => {
      if (resolved) return;
      resolved = true;
      panel.dispose();
      resolve(response);
    };

    // Generate secure nonce for CSP
    const nonce = crypto.randomBytes(16).toString('base64');

    panel.webview.html = getQuestionWebviewHtml({
      question: request.question,
      options: request.options,
      classification,
      agentId,
      toolChain,
      sessionCount: stats.sessionCount,
      nonce,
    });

    // Listen for messages from the webview
    panel.webview.onDidReceiveMessage((msg: { command: string; optionId?: string; optionLabel?: string }) => {
      if (msg.command === 'select' && msg.optionId) {
        finish({
          selectedOptionId: msg.optionId,
          selectedLabel: msg.optionLabel ?? msg.optionId,
          blocked: false,
        });
      } else if (msg.command === 'reject') {
        finish({ selectedOptionId: 'rejected', selectedLabel: 'Rejected', blocked: false });
      }
    });

    // If panel is closed without selection → treat as rejection
    panel.onDidDispose(() => {
      finish({ selectedOptionId: 'rejected', selectedLabel: 'Rejected (dismissed)', blocked: false });
    });
  });
}

// ─── Audit Log Viewer ───────────────────────────────────────────────────────

async function showAuditLog() {
  const dates = auditLog.listDates();
  if (dates.length === 0) {
    vscode.window.showInformationMessage('Agent Checkpoint: No audit entries yet.');
    return;
  }

  // If multiple dates, let user pick; otherwise show today's
  let date: string;
  if (dates.length === 1) {
    date = dates[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      dates.reverse().map(d => ({ label: d })),
      { placeHolder: 'Select a date to view' },
    );
    if (!picked) return;
    date = picked.label;
  }

  const entries = auditLog.readDate(date, 200);
  const lines = entries.map((e, i) => {
    const status = e.blocked ? `BLOCKED: ${e.blockReason}` : `→ ${e.selectedLabel}`;
    const chain = e.hash ? `[${e.hash.slice(0, 8)}]` : '[no-hash]';
    return `${chain} [${e.timestamp}] ${e.classification.toUpperCase()} | ${e.agentId} | "${e.question}" | ${status}`;
  });

  const header = `# Agent Checkpoint Audit Log — ${date}\n# ${entries.length} entries | hash chain: ${entries[0]?.prevHash?.slice(0, 8) ?? 'GENESIS'} → ${entries[entries.length - 1]?.hash?.slice(0, 8) ?? '?'}\n\n`;
  const doc = await vscode.workspace.openTextDocument({
    content: header + lines.join('\n'),
    language: 'log',
  });
  vscode.window.showTextDocument(doc);
}

async function verifyAuditLog() {
  const dates = auditLog.listDates();
  if (dates.length === 0) {
    vscode.window.showInformationMessage('Agent Checkpoint: No audit logs to verify.');
    return;
  }

  let allValid = true;
  const results: string[] = [];

  for (const date of dates) {
    const result = auditLog.verify(date);
    if (result.valid) {
      results.push(`✓ ${date}: ${result.checked} entries — chain intact`);
    } else {
      allValid = false;
      results.push(`✗ ${date}: BROKEN at entry ${result.brokenAt} — ${result.reason}`);
    }
  }

  if (allValid) {
    vscode.window.showInformationMessage(
      `Agent Checkpoint: All ${dates.length} log file(s) verified — hash chain intact.`,
    );
  } else {
    vscode.window.showWarningMessage(
      'Agent Checkpoint: Hash chain integrity failure detected. Check the verification report.',
    );
  }

  const doc = await vscode.workspace.openTextDocument({
    content: `# Agent Checkpoint — Hash Chain Verification\n# ${new Date().toISOString()}\n\n${results.join('\n')}`,
    language: 'log',
  });
  vscode.window.showTextDocument(doc);
}
