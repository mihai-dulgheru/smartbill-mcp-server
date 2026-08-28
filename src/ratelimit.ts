export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A sliding-window limiter that delays rather than rejects.
 *
 * SmartBill V1 blocks a token for ten minutes when it exceeds 30 requests in 10 seconds, which a
 * model iterating over documents can trip trivially. Waiting a few hundred milliseconds is always
 * cheaper than losing the token for ten minutes.
 *
 * ponytail: one shared window per API version; per-endpoint windows only if SmartBill ever
 * publishes per-endpoint limits.
 */
export class SlidingWindow {
  #max: number;
  #windowMs: number;
  #clock: Clock;
  #hits: number[] = [];
  /** Serialises acquires so concurrent callers cannot all read a stale window. */
  #queue: Promise<void> = Promise.resolve();

  constructor(max: number, windowMs: number, clock: Clock = realClock) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  async acquire(): Promise<void> {
    const next = this.#queue.then(() => this.#reserve());
    // Keep the chain alive even if a reservation rejects.
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #reserve(): Promise<void> {
    this.#evict();
    if (this.#hits.length >= this.#max) {
      const oldest = this.#hits[0]!;
      const waitMs = Math.max(1, oldest + this.#windowMs - this.#clock.now());
      if (waitMs > 0) await this.#clock.sleep(waitMs);
      this.#evict();
    }
    this.#hits.push(this.#clock.now());
  }

  #evict(): void {
    const cutoff = this.#clock.now() - this.#windowMs;
    while (this.#hits.length > 0 && this.#hits[0]! < cutoff) this.#hits.shift();
  }
}
