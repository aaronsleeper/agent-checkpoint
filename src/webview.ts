import { QuestionClass } from './types.js';

/**
 * Generates the webview HTML for the Agent Checkpoint question panel.
 * All styles are inline — no external resources needed.
 */
export function getQuestionWebviewHtml(params: {
  question: string;
  options: { id: string; label: string; description?: string }[];
  classification: QuestionClass;
  agentId: string;
  toolChain: string[];
  sessionCount: number;
  nonce: string;
}): string {
  const { question, options, classification, agentId, toolChain, sessionCount, nonce } = params;

  const classColors: Record<QuestionClass, { bg: string; fg: string; label: string }> = {
    informational: { bg: '#1e3a5f', fg: '#7eb8f7', label: 'INFORMATIONAL' },
    permission:    { bg: '#5f3a1e', fg: '#f7b87e', label: 'PERMISSION' },
    sensitive:     { bg: '#5f1e1e', fg: '#f77e7e', label: 'SENSITIVE — BLOCKED' },
  };

  const cls = classColors[classification];
  const chainStr = toolChain.length > 0 ? toolChain.join(' → ') : 'direct call';

  const optionButtons = options.map(opt => `
    <button class="option-btn" data-id="${escapeHtml(opt.id)}" data-label="${escapeHtml(opt.label)}">
      <span class="option-label">${escapeHtml(opt.label)}</span>
      ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
    </button>
  `).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 100vh;
    }

    /* Provenance header — non-forgeable, from extension not agent */
    .provenance {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 6px;
      padding: 12px 16px;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 12px;
      font-size: 12px;
      opacity: 0.85;
    }
    .provenance dt { color: var(--vscode-descriptionForeground, #888); }
    .provenance dd { color: var(--vscode-foreground, #ccc); }

    /* Classification badge */
    .badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      background: ${cls.bg};
      color: ${cls.fg};
    }

    /* Question text */
    .question {
      font-size: 16px;
      line-height: 1.5;
      padding: 8px 0;
    }

    /* Option buttons */
    .options {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .option-btn {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 12px 16px;
      border: 1px solid var(--vscode-button-border, #454545);
      border-radius: 6px;
      background: var(--vscode-button-secondaryBackground, #313131);
      color: var(--vscode-button-secondaryForeground, #ccc);
      cursor: pointer;
      text-align: left;
      font-size: 14px;
      transition: background 0.15s, border-color 0.15s;
    }
    .option-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, #3c3c3c);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .option-btn:focus {
      outline: 2px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 1px;
    }
    .option-label { font-weight: 500; }
    .option-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888);
    }

    /* Reject / Why buttons */
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .action-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .reject-btn {
      background: var(--vscode-errorForeground, #f44747);
      color: #fff;
    }
    .reject-btn:hover { opacity: 0.85; }
    .why-btn {
      background: transparent;
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: underline;
      border: none;
    }
    .why-btn:hover { opacity: 0.85; }

    /* Why panel (hidden by default) */
    .why-panel {
      display: none;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 6px;
      padding: 12px 16px;
      font-size: 12px;
      line-height: 1.6;
    }
    .why-panel.visible { display: block; }
    .why-panel h3 {
      font-size: 13px;
      margin-bottom: 8px;
      color: var(--vscode-textLink-foreground, #3794ff);
    }
  </style>
</head>
<body>
  <!-- Provenance: populated by extension, not controllable by agent -->
  <dl class="provenance">
    <dt>Classification</dt>
    <dd><span class="badge">${cls.label}</span></dd>
    <dt>Agent</dt>
    <dd>${escapeHtml(agentId)}</dd>
    <dt>Tool chain</dt>
    <dd>${escapeHtml(chainStr)}</dd>
    <dt>Session questions</dt>
    <dd>${sessionCount}</dd>
  </dl>

  <div class="question">${escapeHtml(question)}</div>

  <div class="options">
    ${optionButtons}
  </div>

  <div class="actions">
    <button class="action-btn reject-btn" id="reject-btn">Reject</button>
    <button class="action-btn why-btn" id="why-btn">Why am I being asked this?</button>
  </div>

  <div class="why-panel" id="why-panel">
    <h3>Question Context</h3>
    <p><strong>Agent:</strong> ${escapeHtml(agentId)}</p>
    <p><strong>Tool chain:</strong> ${escapeHtml(chainStr)}</p>
    <p><strong>Classification:</strong> ${cls.label} — ${classificationExplanation(classification)}</p>
    <p><strong>Questions this session:</strong> ${sessionCount}</p>
    <p style="margin-top: 8px; opacity: 0.7;">
      This metadata is generated by Agent Checkpoint and cannot be forged by the agent.
      If the tool chain or session count looks unusual, consider rejecting.
    </p>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Option buttons
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({
          command: 'select',
          optionId: btn.dataset.id,
          optionLabel: btn.dataset.label,
        });
      });
    });

    // Reject button
    document.getElementById('reject-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'reject' });
    });

    // Why button
    document.getElementById('why-btn').addEventListener('click', () => {
      document.getElementById('why-panel').classList.toggle('visible');
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function classificationExplanation(cls: QuestionClass): string {
  switch (cls) {
    case 'informational':
      return 'This is a preference or clarification question with no security implications.';
    case 'permission':
      return 'This question involves actions that modify files, execute commands, or affect external systems. Review carefully.';
    case 'sensitive':
      return 'This question was blocked because it appears to involve credentials, payments, or other sensitive data.';
  }
}
