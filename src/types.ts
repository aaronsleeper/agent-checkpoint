/** Classification levels for incoming questions */
export type QuestionClass = 'informational' | 'permission' | 'sensitive';

/** An option the user can select */
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

/** Request from the MCP server to the extension */
export interface AskUserRequest {
  /** Unique ID for this question */
  questionId: string;
  /** The question text to display */
  question: string;
  /** Available options (if empty, treated as yes/no) */
  options: QuestionOption[];
  /** Allow free-form text input (blocked for sensitive questions) */
  allowFreeText?: boolean;
  /** Placeholder text for free-form input */
  freeTextPlaceholder?: string;
  /** Which agent/session is asking */
  agentId?: string;
  /** Recent tool chain leading to this question */
  toolChain?: string[];
  /** Timestamp of the request */
  timestamp: number;
}

/** Response from the extension back to the MCP server */
export interface AskUserResponse {
  /** The selected option ID, or 'rejected' if user dismissed */
  selectedOptionId: string;
  /** The label of the selected option (for readability) */
  selectedLabel: string;
  /** Whether the question was blocked by security policy */
  blocked: boolean;
  /** Reason for blocking (if blocked) */
  blockReason?: string;
}

/** Audit log entry */
export interface AuditEntry {
  timestamp: string;
  questionId: string;
  agentId: string;
  question: string;
  classification: QuestionClass;
  selectedOptionId: string;
  selectedLabel: string;
  blocked: boolean;
  blockReason?: string;
  toolChain: string[];
  /** SHA-256 hash of the previous entry — forms a tamper-evident chain */
  prevHash?: string;
  /** SHA-256 hash of this entry (computed over all fields except this one) */
  hash?: string;
}

/** Rate limiter configuration */
export interface RateLimits {
  /** Max questions per minute */
  perMinute: number;
  /** Max questions per session */
  perSession: number;
  /** Cooldown in ms after a rejected question */
  rejectCooldownMs: number;
}

/** Port file written by the extension for server discovery */
export interface PortInfo {
  port: number;
  token: string;
  pid: number;
}
