import * as fs from 'fs';
import * as path from 'path';
import { AuditEntry } from './types.js';

/**
 * Append-only audit log. Writes to a local file that the user can review.
 * One JSON object per line (JSONL format) for easy parsing.
 */
export class AuditLog {
  private logPath: string;

  constructor(storagePath: string) {
    this.logPath = path.join(storagePath, 'audit.jsonl');
  }

  /** Append an entry to the audit log */
  write(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.appendFileSync(this.logPath, line, 'utf-8');
  }

  /** Read recent entries (last N) */
  readRecent(count: number = 50): AuditEntry[] {
    if (!fs.existsSync(this.logPath)) {
      return [];
    }
    const lines = fs.readFileSync(this.logPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    return lines.slice(-count).map(l => JSON.parse(l) as AuditEntry);
  }

  /** Get the log file path for display */
  getPath(): string {
    return this.logPath;
  }
}
