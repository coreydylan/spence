/**
 * Haptics — feature-detected wrapper around `navigator.vibrate`.
 *
 * iOS Safari does not expose Web Vibration API; this becomes a no-op on
 * unsupported platforms. Android Chrome and most modern desktop browsers
 * support `vibrate()` with a millisecond pattern.
 *
 * Use these helpers (instead of raw `navigator.vibrate`) so the call is
 * always wrapped in feature detection and respects `prefers-reduced-motion`.
 */

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function canVibrate(): boolean {
  if (typeof navigator === "undefined") return false;
  return typeof navigator.vibrate === "function";
}

/** Single short tap-tick (10ms). Suitable for button presses. */
export function tapHaptic(): void {
  if (reducedMotion() || !canVibrate()) return;
  try {
    navigator.vibrate(10);
  } catch {
    /* swallow; some browsers throw on user-gesture restrictions */
  }
}

/** A slightly heavier confirm tick (20ms). For "saved" / commit actions. */
export function confirmHaptic(): void {
  if (reducedMotion() || !canVibrate()) return;
  try {
    navigator.vibrate(20);
  } catch {
    /* noop */
  }
}

/** Short error pattern: two quick beats. */
export function errorHaptic(): void {
  if (reducedMotion() || !canVibrate()) return;
  try {
    navigator.vibrate([20, 60, 20]);
  } catch {
    /* noop */
  }
}

/** Custom pattern, with feature-detect + reduced-motion guard applied. */
export function customHaptic(pattern: number | number[]): void {
  if (reducedMotion() || !canVibrate()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* noop */
  }
}
