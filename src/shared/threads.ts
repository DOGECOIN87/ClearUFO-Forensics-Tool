// Automatic processing thread count (shared by the engine pool and the Settings dialog).
export const MAX_THREADS = 8;
/**
 * Logical CPUs minus one for the interface (all of them on dual-core machines), at most MAX_THREADS; fewer on
 * devices with little memory (every thread holds its own copy of the engine): 2 GB → 2, 4 GB → 4.
 */
export function autoThreads(hc = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 2,
  deviceMemory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory): number {
  const n = hc > 0 ? hc : 2;
  const cap = deviceMemory && deviceMemory <= 2 ? 2 : deviceMemory && deviceMemory <= 4 ? 4 : MAX_THREADS;
  return Math.max(1, Math.min(MAX_THREADS, cap, n >= 4 ? n - 1 : n));
}
