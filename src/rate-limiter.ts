import { RateLimits } from './types.js';

/**
 * Rate limiter and circuit breaker.
 * Runs in the extension (trusted side) — cannot be bypassed by the server.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private sessionCount = 0;
  private rejectCooldownUntil = 0;
  private recentQuestions = new Map<string, number>(); // question hash → timestamp

  constructor(private limits: RateLimits) {}

  /**
   * Check if a question is allowed. Returns null if allowed,
   * or a reason string if blocked.
   */
  check(questionText: string): string | null {
    const now = Date.now();

    // Check reject cooldown
    if (now < this.rejectCooldownUntil) {
      const remaining = Math.ceil((this.rejectCooldownUntil - now) / 1000);
      return `Cooldown active after rejected question (${remaining}s remaining)`;
    }

    // Check per-minute rate
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);
    if (this.timestamps.length >= this.limits.perMinute) {
      return `Rate limit exceeded (${this.limits.perMinute} questions/minute)`;
    }

    // Check session limit
    if (this.sessionCount >= this.limits.perSession) {
      return `Session limit exceeded (${this.limits.perSession} questions/session)`;
    }

    // Check for duplicate questions (same text within 30 seconds)
    const hash = simpleHash(questionText);
    const lastAsked = this.recentQuestions.get(hash);
    if (lastAsked && now - lastAsked < 30_000) {
      return 'Duplicate question detected (same question asked within 30s)';
    }

    return null;
  }

  /** Record that a question was shown to the user */
  record(questionText: string): void {
    const now = Date.now();
    this.timestamps.push(now);
    this.sessionCount++;
    this.recentQuestions.set(simpleHash(questionText), now);
  }

  /** Record that the user rejected/dismissed a question */
  recordRejection(): void {
    this.rejectCooldownUntil = Date.now() + this.limits.rejectCooldownMs;
  }

  /** Reset session counters */
  reset(): void {
    this.timestamps = [];
    this.sessionCount = 0;
    this.rejectCooldownUntil = 0;
    this.recentQuestions.clear();
  }

  /** Get current stats */
  stats(): { sessionCount: number; recentPerMinute: number } {
    const now = Date.now();
    const recentPerMinute = this.timestamps.filter(t => now - t < 60_000).length;
    return { sessionCount: this.sessionCount, recentPerMinute };
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}
