import { QuestionClass, AskUserRequest } from './types.js';

/**
 * Rule-based classifier that runs in the extension (trusted side).
 * Determines the security level of an incoming question.
 *
 * - informational: preference, direction, clarification → show normally
 * - permission: file writes, command execution, external calls → show with context
 * - sensitive: credentials, payments, sharing, accounts → block entirely
 */

const SENSITIVE_PATTERNS = [
  /\b(password|passwd|secret|credential|api[_-]?key|token|ssh[_-]?key)\b/i,
  /\b(credit[_-]?card|bank|routing[_-]?number|account[_-]?number|ssn|social[_-]?security)\b/i,
  /\b(private[_-]?key|access[_-]?key|auth[_-]?token|bearer)\b/i,
  /\bpaste\b.*\b(key|token|secret|password)\b/i,
  /\b(share|forward|send)\b.*\b(credentials|password|key|token)\b/i,
];

const PERMISSION_PATTERNS = [
  /\b(delete|remove|drop|truncate|overwrite|replace)\b/i,
  /\b(create|write|modify|update|edit)\b.*\b(file|directory|folder|table|database)\b/i,
  /\b(execute|run|install|uninstall)\b.*\b(command|script|package|binary)\b/i,
  /\b(push|deploy|publish|release|merge)\b/i,
  /\b(send|post|submit|upload)\b.*\b(email|message|request|data)\b/i,
  /\b(grant|revoke|change)\b.*\b(permission|access|role)\b/i,
  /\bforce\b/i,
  /\b(approve|confirm|authorize)\b/i,
];

export function classifyQuestion(request: AskUserRequest): QuestionClass {
  const text = `${request.question} ${request.options.map(o => `${o.label} ${o.description ?? ''}`).join(' ')}`;

  // Check sensitive patterns first (highest priority)
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return 'sensitive';
    }
  }

  // Check permission patterns
  for (const pattern of PERMISSION_PATTERNS) {
    if (pattern.test(text)) {
      return 'permission';
    }
  }

  return 'informational';
}
