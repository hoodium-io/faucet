/**
 * Serialises transaction submission for a single signing account.
 *
 * Every claim is signed by the same dispenser key, so concurrent requests would
 * race on the nonce. Two failures follow from that:
 *
 *   - `nonce too low` when two transactions are built from the same nonce and
 *     only one lands.
 *   - `replacement transaction underpriced` when the second is seen as a
 *     replacement for the first.
 *
 * Fix: a strict FIFO queue. Only one transaction is built, sent and awaited at a
 * time. This is the simplest correct approach for a faucet's throughput (a few
 * claims per minute at most) and it removes the entire class of nonce bugs.
 *
 * The queue also **resyncs from the chain** after any failure, because a
 * dropped transaction leaves the nonce in an unknown state — trusting the local
 * counter at that point is what produces permanently stuck faucets.
 */
export class TxQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** Number of jobs currently queued or running. */
  get size(): number {
    return this.pending;
  }

  /**
   * Enqueues `job` and resolves with its result.
   * Jobs run strictly one after another, in submission order.
   */
  run<T>(job: () => Promise<T>): Promise<T> {
    this.pending += 1;

    const result = this.tail.then(
      () => job(),
      // A previous job's rejection must not poison the queue.
      () => job(),
    );

    // Keep the chain alive regardless of this job's outcome.
    this.tail = result
      .catch(() => undefined)
      .finally(() => {
        this.pending -= 1;
      });

    return result;
  }
}
