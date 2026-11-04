import { expect, it } from 'vitest';
import { jobRetry } from '../../../convex/job_policy';

it('waits beyond a normal tutor turn for busy capacity and stops after three attempts', () => {
  expect(jobRetry(1, 429)).toEqual({ delayMs: 60000, code: 'WORK_CAPACITY' });
  expect(jobRetry(2, 429)).toEqual({ delayMs: 120000, code: 'WORK_CAPACITY' });
  expect(jobRetry(3, 429)).toEqual({ code: 'WORK_CAPACITY' });
});
it('does not immediately retry exhausted daily allowance and retains bounded transient retries', () => {
  expect(jobRetry(1, 429, 'DAILY_USAGE_LIMIT')).toEqual({ code: 'DAILY_USAGE_LIMIT' });
  expect(jobRetry(1, 503).delayMs).toBe(2000); expect(jobRetry(2, 503).delayMs).toBe(15000); expect(jobRetry(3, 503).delayMs).toBeUndefined();
});
