import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AskUserRequest, AskUserResponse, AuditEntry, PortInfo, QuestionClass } from './types.js';
import { classifyQuestion } from './classifier.js';
import { RateLimiter } from './rate-limiter.js';
import { AuditLog } from './audit.js';

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

async function showQuestionUI(
  request: AskUserRequest,
  classification: QuestionClass,
  agentId: string,
  toolChain: string[],
): Promise<AskUserResponse> {
  const stats = rateLimiter.stats();
  const classIcon = classification === 'permission' ? '$(shield)' : '$(comment-discussion)';
  const chainStr = toolChain.length > 0 ? toolChain.join(' → ') : 'direct';

  // Build provenance header (non-forgeable — comes from extension, not agent)
  const provenanceLines = [
    `${classIcon} ${classification.toUpperCase()}`,
    `Agent: ${agentId}`,
    `Tool chain: ${chainStr}`,
    `Questions this session: ${stats.sessionCount}`,
  ];

  // Use QuickPick for rich UI
  const items: vscode.QuickPickItem[] = request.options.map(opt => ({
    label: opt.label,
    description: opt.description ?? '',
    detail: opt.id,
  }));

  // Add reject option at the bottom
  items.push({
    label: '$(close) Reject',
    description: 'Dismiss this question',
    detail: 'rejected',
    kind: vscode.QuickPickItemKind.Separator,
  } as vscode.QuickPickItem);
  items.push({
    label: '$(close) Reject this question',
    description: '',
    detail: 'rejected',
  });

  // If permission class, add a "Why?" info option
  if (classification === 'permission') {
    items.push({
      label: '$(info) Why am I being asked this?',
      description: '',
      detail: '__why__',
    });
  }

  const provenance = provenanceLines.join('  |  ');

  const selected = await vscode.window.showQuickPick(items, {
    title: `Agent Question [${provenance}]`,
    placeHolder: request.question,
    ignoreFocusOut: true,
  });

  // Handle "Why?" selection — show detail, then re-prompt
  if (selected?.detail === '__why__') {
    await vscode.window.showInformationMessage(
      `Agent "${agentId}" asked this after: ${chainStr}.\n\nClassification: ${classification}\nSession question count: ${stats.sessionCount}`,
      { modal: true },
      'OK',
    );
    // Re-show the question (without Why option to avoid infinite loop)
    return showQuestionUI(request, 'informational', agentId, toolChain);
  }

  if (!selected || selected.detail === 'rejected') {
    return {
      selectedOptionId: 'rejected',
      selectedLabel: 'Rejected',
      blocked: false,
    };
  }

  const matchedOption = request.options.find(o => o.id === selected.detail);
  return {
    selectedOptionId: matchedOption?.id ?? selected.detail ?? 'unknown',
    selectedLabel: matchedOption?.label ?? selected.label,
    blocked: false,
  };
}

// ─── Audit Log Viewer ───────────────────────────────────────────────────────

function showAuditLog() {
  const entries = auditLog.readRecent(30);
  if (entries.length === 0) {
    vscode.window.showInformationMessage('Agent Checkpoint: No audit entries yet.');
    return;
  }

  const lines = entries.map(e => {
    const status = e.blocked ? `BLOCKED: ${e.blockReason}` : `→ ${e.selectedLabel}`;
    return `[${e.timestamp}] ${e.classification.toUpperCase()} | ${e.agentId} | "${e.question}" | ${status}`;
  });

  const doc = vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'log',
  });
  doc.then(d => vscode.window.showTextDocument(d));
}
