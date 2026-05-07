/**
 * Wake Lock — keep the screen awake during cook mode (or any kitchen-friendly
 * surface). Phase 5's cook mode owns this primarily; we ship the helper here
 * so any client surface can request it.
 *
 * Standard usage:
 *
 *   const release = await acquireWakeLock();
 *   // …user is cooking…
 *   release();
 *
 * The wrapper auto-reacquires when the document becomes visible again, since
 * iOS releases wake locks aggressively on backgrounding.
 */

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", cb: () => void) => void;
};

interface WakeLockApi {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

function getWakeLock(): WakeLockApi | null {
  if (typeof navigator === "undefined") return null;
  // The Navigator type has `wakeLock` in modern lib.dom; fall back to a runtime check
  // for older TS targets / older browsers.
  const api = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
  return api ?? null;
}

export function isWakeLockSupported(): boolean {
  return getWakeLock() != null;
}

/**
 * Acquire a screen wake lock. Returns a release function. If the platform
 * doesn't support Wake Lock API, returns a no-op release. The lock auto-renews
 * on visibility change.
 */
export async function acquireWakeLock(): Promise<() => void> {
  const api = getWakeLock();
  if (!api) return () => {};

  let sentinel: WakeLockSentinelLike | null = null;
  let released = false;

  const acquire = async () => {
    if (released) return;
    try {
      sentinel = await api.request("screen");
    } catch {
      sentinel = null;
    }
  };

  const onVisible = () => {
    if (document.visibilityState === "visible" && !released && !sentinel?.released) {
      void acquire();
    }
  };

  await acquire();
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    released = true;
    document.removeEventListener("visibilitychange", onVisible);
    if (sentinel && !sentinel.released) {
      void sentinel.release();
    }
  };
}
