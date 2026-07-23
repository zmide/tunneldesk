const assert = require("node:assert/strict");
const { LoginRateLimiter, SessionStore } = require("../dist/auth-protection");

let now = 1_000_000;
const limiter = new LoginRateLimiter({
  maxFailures: 5,
  windowMs: 300_000,
  lockMs: 300_000,
  globalMaxFailures: 50,
  globalWindowMs: 300_000,
  globalLockMs: 60_000
}, () => now);

for (let index = 0; index < 4; index += 1) {
  assert.equal(limiter.recordFailure("192.0.2.10").allowed, true);
}
const locked = limiter.recordFailure("192.0.2.10");
assert.equal(locked.allowed, false);
assert.equal(locked.retryAfterMs, 300_000);
now += 299_999;
assert.equal(limiter.check("192.0.2.10").allowed, false);
now += 1;
assert.equal(limiter.check("192.0.2.10").allowed, true);
limiter.recordFailure("192.0.2.10");
limiter.recordSuccess("192.0.2.10");
assert.equal(limiter.check("192.0.2.10").allowed, true);

const globalLimiter = new LoginRateLimiter({
  maxFailures: 99,
  globalMaxFailures: 3,
  globalLockMs: 10_000
}, () => now);
globalLimiter.recordFailure("192.0.2.1");
globalLimiter.recordFailure("192.0.2.2");
assert.equal(globalLimiter.recordFailure("192.0.2.3").allowed, false);
assert.equal(globalLimiter.check("192.0.2.99").allowed, false);
now += 10_000;
assert.equal(globalLimiter.check("192.0.2.99").allowed, true);

const sessions = new SessionStore({ ttlMs: 1000, maxSessions: 2 }, () => now);
const first = sessions.create();
const second = sessions.create();
assert.ok(sessions.get(first));
const third = sessions.create();
assert.equal(sessions.get(first), null);
assert.ok(sessions.get(second));
assert.ok(sessions.get(third));
sessions.configure({ ttlMs:500, maxSessions:1 });
assert.equal(sessions.get(second), null);
assert.ok(sessions.get(third));
now += 1001;
assert.equal(sessions.cleanup(), 1);
assert.equal(sessions.size(), 0);

assert.throws(() => sessions.configure({ ttlMs:0 }), /会话有效期/);
assert.throws(() => sessions.configure({ maxSessions:0 }), /最大会话数/);

console.log("Web 登录保护检查通过：来源限速、全局限速、短时锁定、会话上限、运行时重配置与过期清理");
