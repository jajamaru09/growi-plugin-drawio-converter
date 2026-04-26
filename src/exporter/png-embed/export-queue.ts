// src/exporter/png-embed/export-queue.ts
// Single-chain serial queue for PNG export jobs. Ensures only one drawio
// embed session runs at a time, even when multiple diagrams on the same
// page are clicked in rapid succession.
//
// Jobs are chained with `.then(job, job)` so a failed job does not block
// subsequent jobs (F8 in the spec).
import { log } from '../../logger';

let chain: Promise<unknown> = Promise.resolve();
let queueLength = 0;

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  queueLength++;
  const position = queueLength;
  log(`export-queue: enqueued (position=${position})`);

  const wrapped = (): Promise<T> => {
    log(`export-queue: job starting (remaining before=${queueLength})`);
    return job().finally(() => {
      queueLength--;
      log(`export-queue: job finished (remaining=${queueLength})`);
    });
  };

  const result = chain.then(wrapped, wrapped) as Promise<T>;
  // Prevent unhandled rejection propagating into the shared chain:
  chain = result.catch(() => { /* swallow for chain continuity */ });
  return result;
}

export function getQueueLength(): number {
  return queueLength;
}
