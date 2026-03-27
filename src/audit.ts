import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AuditEntry } from './types.js';

/**
 * Tamper-evident, daily-rotating audit log.
 *
 * - Each entry includes a SHA-256 hash of the previous entry (hash chain).
 *   Deleting or modifying any line breaks the chain, making tampering detectable.
 * - Log files rotate daily: audit-2026-03-27.jsonl, audit-2026-03-28.jsonl, etc.
 * - One JSON object per line (JSONL) for easy parsing and streaming.
 */
export class AuditLog {
  private storageDir: string;
  private lastHash: string = 'GENESIS';

  constructor(storagePath: string) {
    this.storageDir = path.join(storagePath, 'audit');
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.lastHash = this.recoverLastHash();
  }

  /** Append a hash-chained entry to today's log file */
  write(entry: AuditEntry): void {
    // Attach chain pointers
    entry.prevHash = this.lastHash;

    // Hash is computed over all fields except `hash` itself
    const hashInput = JSON.stringify({ ...entry, hash: undefined });
    entry.hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    // Write and advance the chain
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.todayPath(), line, 'utf-8');
    this.lastHash = entry.hash;
  }

  /** Read recent entries from today's log (last N) */
  readRecent(count: number = 50): AuditEntry[] {
    return this.readFile(this.todayPath(), count);
  }

  /** Read entries from a specific date (YYYY-MM-DD) */
  readDate(date: string, count: number = 200): AuditEntry[] {
    const filePath = path.join(this.storageDir, `audit-${date}.jsonl`);
    return this.readFile(filePath, count);
  }

  /** List all available log dates */
  listDates(): string[] {
    if (!fs.existsSync(this.storageDir)) return [];
    return fs.readdirSync(this.storageDir)
      .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .map(f => f.replace('audit-', '').replace('.jsonl', ''))
      .sort();
  }

  /**
   * Verify the hash chain integrity for a given date.
   * Returns { valid: true } or { valid: false, brokenAt: index, reason: string }.
   */
  verify(date?: string): { valid: boolean; brokenAt?: number; reason?: string; checked: number } {
    const filePath = date
      ? path.join(this.storageDir, `audit-${date}.jsonl`)
      : this.todayPath();

    const entries = this.readFile(filePath, Infinity);
    if (entries.length === 0) {
      return { valid: true, checked: 0 };
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Recompute the hash for this entry
      const expectedInput = JSON.stringify({ ...entry, hash: undefined });
      const expectedHash = crypto.createHash('sha256').update(expectedInput).digest('hex');

      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Entry ${i} hash mismatch — content was modified`,
          checked: i,
        };
      }

      // Check chain linkage (skip first entry — it links to previous day or GENESIS)
      if (i > 0 && entry.prevHash !== entries[i - 1].hash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Entry ${i} prevHash doesn't match entry ${i - 1} hash — entry was inserted or deleted`,
          checked: i,
        };
      }
    }

    return { valid: true, checked: entries.length };
  }

  /** Get the storage directory path */
  getDir(): string {
    return this.storageDir;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private todayPath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(this.storageDir, `audit-${date}.jsonl`);
  }

  private readFile(filePath: string, count: number): AuditEntry[] {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const slice = count === Infinity ? lines : lines.slice(-count);
    return slice.map(l => JSON.parse(l) as AuditEntry);
  }

  /** Recover the last hash from the most recent log file to continue the chain across restarts */
  private recoverLastHash(): string {
    const dates = this.listDates();
    if (dates.length === 0) return 'GENESIS';

    // Read the last entry from the most recent date
    const lastDate = dates[dates.length - 1];
    const entries = this.readDate(lastDate, 1);
    // readDate returns last N, so this is the final entry
    const allEntries = this.readFile(
      path.join(this.storageDir, `audit-${lastDate}.jsonl`),
      Infinity,
    );
    const lastEntry = allEntries[allEntries.length - 1];
    return lastEntry?.hash ?? 'GENESIS';
  }
}
