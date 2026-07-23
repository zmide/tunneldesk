import crypto from "node:crypto";

export interface LoginProtectionOptions {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  globalMaxFailures: number;
  globalWindowMs: number;
  globalLockMs: number;
}

export interface LoginCheckResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface LoginAttempt {
  failures: number[];
  lockedUntil: number;
  lastSeenAt: number;
}

const DEFAULT_LOGIN_OPTIONS: LoginProtectionOptions = {
  maxFailures: 5,
  windowMs: 5 * 60 * 1000,
  lockMs: 5 * 60 * 1000,
  globalMaxFailures: 50,
  globalWindowMs: 5 * 60 * 1000,
  globalLockMs: 60 * 1000
};

export class LoginRateLimiter {
  readonly options: LoginProtectionOptions;
  private readonly now: () => number;
  private readonly attempts = new Map<string, LoginAttempt>();
  private globalFailures: number[] = [];
  private globalLockedUntil = 0;

  constructor(options: Partial<LoginProtectionOptions> = {}, now: () => number = Date.now) {
    this.options = { ...DEFAULT_LOGIN_OPTIONS, ...options };
    this.now = now;
  }

  check(source: string): LoginCheckResult {
    const current = this.now();
    this.prune(current);
    const attempt = this.attempts.get(source);
    const lockedUntil = Math.max(this.globalLockedUntil, attempt?.lockedUntil || 0);
    return {
      allowed: lockedUntil <= current,
      retryAfterMs: Math.max(0, lockedUntil - current)
    };
  }

  recordFailure(source: string): LoginCheckResult {
    const current = this.now();
    this.prune(current);
    const attempt = this.attempts.get(source) || { failures: [], lockedUntil: 0, lastSeenAt: current };
    attempt.failures.push(current);
    attempt.lastSeenAt = current;
    if (attempt.failures.length >= this.options.maxFailures) {
      attempt.lockedUntil = Math.max(attempt.lockedUntil, current + this.options.lockMs);
      attempt.failures = [];
    }
    this.attempts.set(source, attempt);

    this.globalFailures.push(current);
    if (this.globalFailures.length >= this.options.globalMaxFailures) {
      this.globalLockedUntil = Math.max(this.globalLockedUntil, current + this.options.globalLockMs);
      this.globalFailures = [];
    }
    return this.check(source);
  }

  recordSuccess(source: string): void {
    this.attempts.delete(source);
  }

  clear(): void {
    this.attempts.clear();
    this.globalFailures = [];
    this.globalLockedUntil = 0;
  }

  cleanup(): void {
    this.prune(this.now());
  }

  size(): number {
    return this.attempts.size;
  }

  private prune(current: number): void {
    const sourceCutoff = current - Math.max(this.options.windowMs, this.options.lockMs);
    for (const [source, attempt] of this.attempts) {
      attempt.failures = attempt.failures.filter(value => value > current - this.options.windowMs);
      if (attempt.lockedUntil <= current && attempt.failures.length === 0 && attempt.lastSeenAt < sourceCutoff) {
        this.attempts.delete(source);
      }
    }
    this.globalFailures = this.globalFailures.filter(value => value > current - this.options.globalWindowMs);
    if (this.globalLockedUntil <= current) this.globalLockedUntil = 0;
  }
}

export interface SessionStoreOptions {
  ttlMs: number;
  maxSessions: number;
}

export interface SessionRecord {
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  readonly options: SessionStoreOptions;
  private readonly now: () => number;
  private readonly tokens = new Map<string, SessionRecord>();

  constructor(
    options: Partial<SessionStoreOptions> = {},
    now: () => number = Date.now
  ) {
    this.options = {
      ttlMs: options.ttlMs || 12 * 60 * 60 * 1000,
      maxSessions: options.maxSessions || 1000
    };
    this.now = now;
  }

  create(): string {
    this.cleanup();
    while (this.tokens.size >= this.options.maxSessions) {
      const oldest = this.tokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tokens.delete(oldest);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const current = this.now();
    this.tokens.set(token, { createdAt: current, expiresAt: current + this.options.ttlMs });
    return token;
  }

  configure(options: Partial<SessionStoreOptions>): void {
    const ttlMs = Number(options.ttlMs ?? this.options.ttlMs);
    const maxSessions = Number(options.maxSessions ?? this.options.maxSessions);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("会话有效期必须大于 0");
    if (!Number.isInteger(maxSessions) || maxSessions <= 0) throw new Error("最大会话数必须为正整数");
    this.options.ttlMs = Math.floor(ttlMs);
    this.options.maxSessions = maxSessions;

    for (const item of this.tokens.values()) {
      item.expiresAt = Math.min(item.expiresAt, item.createdAt + this.options.ttlMs);
    }
    this.cleanup();
    while (this.tokens.size > this.options.maxSessions) {
      const oldest = this.tokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tokens.delete(oldest);
    }
  }

  get(token: string): SessionRecord | null {
    const item = this.tokens.get(token);
    if (!item) return null;
    if (item.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return null;
    }
    return item;
  }

  delete(token: string): void {
    this.tokens.delete(token);
  }

  clear(): void {
    this.tokens.clear();
  }

  cleanup(): number {
    const current = this.now();
    let deleted = 0;
    for (const [token, item] of this.tokens) {
      if (item.expiresAt > current) continue;
      this.tokens.delete(token);
      deleted += 1;
    }
    return deleted;
  }

  size(): number {
    return this.tokens.size;
  }
}
