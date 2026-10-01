// A small in-memory token bucket. Process-local, resets on restart, and bounded in size.
export class TokenBucketLimiter {
  constructor({ perMinute, now = Date.now, maxKeys = 20_000 }) {
    this.capacity = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  /** Spend one token for `key`. Returns { ok, retryAfterSeconds }. */
  take(key) {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      const elapsed = Math.max(0, nowMs - bucket.at);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.at = nowMs;
      // Re-insert so the Map order tracks recency for eviction.
      this.buckets.delete(key);
    } else {
      bucket = { tokens: this.capacity, at: nowMs };
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        this.buckets.delete(oldest);
      }
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, retryAfterSeconds: 0 };
    }
    const waitMs = (1 - bucket.tokens) / this.refillPerMs;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
}
