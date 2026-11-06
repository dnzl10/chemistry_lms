/**
 * Sliding window rate limiter for batch actions and bulk communications.
 */
class SlidingWindowRateLimiter {
    constructor(maxEvents = 60, windowMs = 60000) {
        this.maxEvents = maxEvents;
        this.windowMs = windowMs;
        this.timestamps = new Map(); // key -> [timestamps]
    }

    /**
     * Checks whether an action for key is within allowed rate.
     * @param {string} key e.g. teacher_id or ip
     * @param {number} count Number of dispatches requested
     * @returns {{allowed: boolean, remaining: number, retryAfterSec: number}}
     */
    check(key, count = 1) {
        const now = Date.now();
        const cutoff = now - this.windowMs;

        let records = this.timestamps.get(key) || [];
        records = records.filter(ts => ts > cutoff);

        if (records.length + count > this.maxEvents) {
            const oldest = records[0] || now;
            const retryAfterSec = Math.ceil((oldest + this.windowMs - now) / 1000);
            return {
                allowed: false,
                remaining: Math.max(0, this.maxEvents - records.length),
                retryAfterSec: Math.max(1, retryAfterSec)
            };
        }

        for (let i = 0; i < count; i++) {
            records.push(now);
        }
        this.timestamps.set(key, records);

        return {
            allowed: true,
            remaining: this.maxEvents - records.length,
            retryAfterSec: 0
        };
    }

    /**
     * Periodic cleanup of stale keys
     */
    cleanup() {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        for (const [key, records] of this.timestamps.entries()) {
            const active = records.filter(ts => ts > cutoff);
            if (active.length === 0) {
                this.timestamps.delete(key);
            } else {
                this.timestamps.set(key, active);
            }
        }
    }
}

const batchMessageLimiter = new SlidingWindowRateLimiter(60, 60000); // 60 msgs per min
setInterval(() => batchMessageLimiter.cleanup(), 120000);

module.exports = {
    SlidingWindowRateLimiter,
    batchMessageLimiter
};
