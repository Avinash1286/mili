/** Capacity backoff must outlast a normal bounded tutor request. */
export function jobRetry(attempts: number, status?: number, code?: string): { delayMs?: number; code: string } {
  if (code === 'DAILY_USAGE_LIMIT') return { code };
  if (attempts >= 3) return { code: status === 429 ? 'WORK_CAPACITY' : 'JOB_EXECUTION_FAILED' };
  return { delayMs: status === 429 ? attempts * 60000 : attempts === 1 ? 2000 : 15000, code: status === 429 ? 'WORK_CAPACITY' : 'JOB_EXECUTION_FAILED' };
}
