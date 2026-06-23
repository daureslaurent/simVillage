/**
 * agent/src/llm/SerialQueue.ts
 * ---------------------------------------------------------------------------
 * A FIFO serializer: every task handed to `run()` executes strictly one at a
 * time, in the order submitted, no matter how many callers fire concurrently.
 *
 * This is what makes the single llama server safe. The whole village shares one
 * server, so the engine pushes every decision / completion / embedding through
 * ONE of these — concurrent requests queue instead of dog-piling a box that can
 * only think one thought at a time. An optional `minGapMs` paces successive
 * tasks apart, leaving the server headroom between calls.
 * ---------------------------------------------------------------------------
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SerialQueue {
  /** The chain tail: each new task `.then`s off this, then becomes the new tail. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Wall-clock time the previous task finished, for `minGapMs` pacing. */
  private lastFinishedAt = 0;

  constructor(private readonly minGapMs = 0) {}

  /** Enqueue `task`; resolves/rejects with its outcome once it runs in turn. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.minGapMs > 0) {
        const wait = this.minGapMs - (Date.now() - this.lastFinishedAt);
        if (wait > 0) await sleep(wait);
      }
      try {
        return await task();
      } finally {
        this.lastFinishedAt = Date.now();
      }
    });
    // Keep the chain alive regardless of THIS task's outcome, so one rejection
    // never poisons the queue for everyone behind it.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
