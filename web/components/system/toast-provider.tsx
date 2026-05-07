"use client";

import * as React from "react";
import { Toast, type ToastShape, type ToastTone } from "./toast";

interface ToastContextValue {
  show: (input: Omit<ToastShape, "id"> | string) => string;
  dismiss: (id: string) => void;
  /** Convenience: `info` / `success` / `warn` / `error` shortcuts. */
  info: (message: string, opts?: Partial<Omit<ToastShape, "id" | "tone" | "message">>) => string;
  success: (message: string, opts?: Partial<Omit<ToastShape, "id" | "tone" | "message">>) => string;
  warn: (message: string, opts?: Partial<Omit<ToastShape, "id" | "tone" | "message">>) => string;
  error: (message: string, opts?: Partial<Omit<ToastShape, "id" | "tone" | "message">>) => string;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

let counter = 0;
function uid(): string {
  counter += 1;
  return `t_${Date.now().toString(36)}_${counter}`;
}

/**
 * ToastProvider — mount once at the app root. Renders a fixed stack of toasts
 * just above the bottom tab bar (or above the iOS safe area on full-screen
 * routes). Use `useToast()` from any client component to fire one.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastShape[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = React.useCallback(
    (input: Omit<ToastShape, "id"> | string): string => {
      const id = uid();
      const next: ToastShape =
        typeof input === "string"
          ? { id, tone: "info", message: input }
          : { id, ...input };
      setToasts((prev) => [...prev.slice(-3), next]);
      return id;
    },
    [],
  );

  const tone = (t: ToastTone) =>
    (msg: string, opts: Partial<Omit<ToastShape, "id" | "tone" | "message">> = {}) =>
      show({ tone: t, message: msg, ...opts });

  const value = React.useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      info: tone("info"),
      success: tone("success"),
      warn: tone("warn"),
      error: tone("error"),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4"
        style={{
          // Sits just above the bottom tab bar (h-14 ≈ 3.5rem) + safe-area-bottom.
          bottom: "calc(env(safe-area-inset-bottom) + 4.5rem)",
        }}
        aria-live="polite"
      >
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Hook: returns the toast API. Must be inside a ToastProvider — throws otherwise.
 *
 *   const toast = useToast();
 *   toast.success("Saved.");
 */
export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() must be used inside <ToastProvider>");
  }
  return ctx;
}

/**
 * Hook variant that doesn't throw if there's no provider — useful for
 * library-style components that may render outside the provider tree.
 */
export function useToastOptional(): ToastContextValue | null {
  return React.useContext(ToastContext);
}
