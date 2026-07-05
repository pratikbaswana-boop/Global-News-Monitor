// FIFO rate limiter for Kite Connect REST calls (#3).
//
// When N users are dispatched on the same edge, their broker calls (getMargins, placeOrder)
// must not run fully serially (user 4 gets a visibly worse fill than user 1) nor blast Kite's
// ~10 req/s order limit. This gates the START of each call to a fixed spacing, FIFO — so calls
// from all users interleave in arrival order (fair) and never exceed the rate, while their I/O
// still overlaps once started.

// Conservative cap below Kite's ~10 req/s order limit (shared headroom for quotes/positions).
const MAX_STARTS_PER_SEC = 7;
const MIN_SPACING_MS = 1000 / MAX_STARTS_PER_SEC;

const queue: Array<() => void> = [];
let lastStart = 0;
let pumping = false;

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const wait = Math.max(0, lastStart + MIN_SPACING_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastStart = Date.now();
      queue.shift()!();
    }
  } finally {
    pumping = false;
  }
}

/**
 * Run a Kite REST call through the shared limiter. Resolves/rejects with the job's result.
 * Job starts are spaced ≥ MIN_SPACING_MS apart, FIFO; execution overlaps once started.
 */
export function runKiteLimited<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      job().then(resolve, reject);
    });
    void pump();
  });
}

/** Current backlog depth (diagnostics). */
export function kiteLimiterDepth(): number {
  return queue.length;
}
