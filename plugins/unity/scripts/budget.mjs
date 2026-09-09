import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const DIAGNOSTIC_MS = 6000;
export function remaining(cap = DIAGNOSTIC_MS) {
  const ms = Math.min(cap, (scope.getStore() ?? Infinity) - Date.now());
  if (ms <= 0) throw Object.assign(new Error('The diagnostic time budget was exhausted.'), { code: 'DIAGNOSTIC_TIMEOUT' });
  return Math.max(1, Math.floor(ms));
}
export function withinBudget(fn, ms = DIAGNOSTIC_MS) {
  return scope.run(Math.min(scope.getStore() ?? Infinity, Date.now() + ms), fn);
}

export function outsideBudget(fn) { return scope.run(Infinity, fn); }
