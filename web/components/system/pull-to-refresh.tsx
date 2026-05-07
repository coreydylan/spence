"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface PullToRefreshProps {
  /** Async callback fired once the pull crosses the threshold and is released. */
  onRefresh: () => void | Promise<void>;
  children: React.ReactNode;
  /** Pull distance (px) needed to trigger refresh. Default 64. */
  threshold?: number;
  /** Multiplier on raw drag distance (rubber-band feel). Default 0.5. */
  resistance?: number;
  className?: string;
  disabled?: boolean;
}

/**
 * PullToRefresh — native-feeling iOS/Android pull gesture.
 *
 * Activates only when the contained scroller is at scrollTop=0. Below that,
 * it stays out of the way (children scroll normally). Falls back gracefully
 * on environments without touch events — children render as-is.
 *
 * Visual treatment: a small terracotta dot fades in as the user pulls,
 * rotating slightly on release while `onRefresh` runs.
 */
export function PullToRefresh({
  onRefresh,
  children,
  threshold = 64,
  resistance = 0.5,
  className,
  disabled,
}: PullToRefreshProps) {
  const [pull, setPull] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const startYRef = React.useRef<number | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    if (disabled || refreshing) return;
    const el = containerRef.current;
    if (!el) return;
    // Only activate when at top of scroll
    if (el.scrollTop > 0) {
      startYRef.current = null;
      return;
    }
    startYRef.current = e.touches[0].clientY;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (startYRef.current == null || refreshing) return;
    const dy = e.touches[0].clientY - startYRef.current;
    if (dy <= 0) {
      setPull(0);
      return;
    }
    setPull(Math.min(dy * resistance, threshold * 1.6));
  };

  const onTouchEnd = async () => {
    if (refreshing) return;
    if (pull >= threshold) {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
        setPull(0);
        startYRef.current = null;
      }
    } else {
      setPull(0);
      startYRef.current = null;
    }
  };

  const progress = Math.min(pull / threshold, 1);

  return (
    <div
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      className={cn("overflow-y-auto h-full", className)}
    >
      <div
        aria-hidden={pull === 0 && !refreshing}
        className="flex items-center justify-center -mt-12 h-12 transition-opacity"
        style={{
          transform: `translateY(${refreshing ? threshold : pull}px)`,
          opacity: refreshing ? 1 : progress,
          transition: refreshing ? "transform 200ms ease-out" : pull === 0 ? "transform 200ms ease-out, opacity 200ms ease-out" : undefined,
        }}
      >
        <span
          className={cn(
            "h-6 w-6 rounded-full border-2 border-terracotta border-t-transparent",
            refreshing && "animate-spin",
          )}
          style={{
            transform: refreshing ? undefined : `rotate(${progress * 360}deg)`,
            opacity: refreshing ? 1 : 0.4 + progress * 0.6,
          }}
        />
      </div>
      <div
        style={{
          transform: refreshing ? `translateY(${threshold}px)` : `translateY(${pull}px)`,
          transition: refreshing
            ? "transform 200ms ease-out"
            : pull === 0
              ? "transform 200ms ease-out"
              : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
