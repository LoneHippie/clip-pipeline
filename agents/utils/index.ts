/**
 * Retry a promise-returning function up to `maxAttempts` times with exponential back-off.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  label = 'operation',
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = 2000 * attempt;
        console.warn(`[retry] ${label} attempt ${attempt} failed — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
