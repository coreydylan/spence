"use client";

import * as React from "react";
import { resizeImage } from "@/lib/photo-resize";

export type PhotoCaptureState =
  | { kind: "idle" }
  | { kind: "resizing" }
  | { kind: "uploading"; progress?: number }
  | { kind: "analyzing"; photo_id: string }
  | { kind: "done"; photo_id: string }
  | { kind: "error"; message: string };

export interface PhotoCaptureProps {
  cook_session_id: string;
  member_id: string;
  /** Optional task_id to attach the photo to. */
  task_id?: string | null;
  /** Called once the upload completes (vision response may still be pending). */
  onUploaded?: (result: {
    photo_id: string;
    vision_pending: boolean;
    analysis?: unknown;
  }) => void;
  /** Optional override label for the capture button. */
  label?: string;
  className?: string;
}

/**
 * PhotoCapture — camera intent button + upload pipeline.
 *
 * Flow:
 *   1. User taps the button → fires a `<input type=file capture=environment>`
 *   2. Browser opens the camera (mobile) or file picker (desktop fallback)
 *   3. We resize client-side via `resizeImage` (≤1024px longest edge)
 *   4. POST to `/api/cook/photo-upload?cook_session_id=…&member_id=…&task_id=…`
 *   5. Show "Analyzing…" pill while the worker calls bridge-vision
 *   6. The eventual `iteration_suggested` arrives over the WebSocket — handled
 *      upstream by the active page; this component just reports the upload.
 *
 * Retry: one automatic retry on transient failure (network blip etc.).
 */
export function PhotoCapture(props: PhotoCaptureProps) {
  const { cook_session_id, member_id, task_id, onUploaded, label, className } =
    props;
  const [state, setState] = React.useState<PhotoCaptureState>({ kind: "idle" });
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const onChange = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so the same file can be re-selected if the user retries.
      if (inputRef.current) inputRef.current.value = "";
      if (!file) return;

      setState({ kind: "resizing" });
      let blob: Blob;
      try {
        blob = await resizeImage(file, { maxEdge: 1024, mime: "image/jpeg" });
      } catch (err) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "resize_failed",
        });
        return;
      }

      setState({ kind: "uploading" });
      const result = await uploadOnce(blob, {
        cook_session_id,
        member_id,
        task_id: task_id ?? null,
      }).catch(() => null);

      const final = result
        ? result
        : await uploadOnce(blob, {
            cook_session_id,
            member_id,
            task_id: task_id ?? null,
          }).catch(() => null);

      if (!final) {
        setState({ kind: "error", message: "upload_failed_after_retry" });
        return;
      }

      const photo_id =
        typeof final === "object" && final && "photo_id" in final
          ? String((final as { photo_id?: unknown }).photo_id ?? "")
          : "";
      const vision_pending =
        typeof final === "object" &&
        final &&
        "vision_pending" in final &&
        Boolean((final as { vision_pending?: unknown }).vision_pending);

      onUploaded?.({
        photo_id,
        vision_pending,
        analysis:
          typeof final === "object" && final && "analysis" in final
            ? (final as { analysis?: unknown }).analysis
            : undefined,
      });

      if (vision_pending) {
        setState({ kind: "analyzing", photo_id });
      } else {
        setState({ kind: "done", photo_id });
      }
    },
    [cook_session_id, member_id, task_id, onUploaded],
  );

  const isBusy =
    state.kind === "resizing" ||
    state.kind === "uploading" ||
    state.kind === "analyzing";

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={onChange}
      />
      <button
        type="button"
        disabled={isBusy}
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-[var(--radius-md)] border border-cream-dim/30 bg-ink-surface text-cream-dim text-lg font-medium px-5 py-4 hover:bg-ink-surface-2 active:bg-ink-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3"
      >
        <CameraIcon />
        {captureButtonLabel(state, label)}
      </button>

      {state.kind === "error" && (
        <p className="mt-2 text-sm text-amber" role="alert">
          {state.message}. Tap to try again.
        </p>
      )}
    </div>
  );
}

function captureButtonLabel(state: PhotoCaptureState, override?: string): string {
  if (state.kind === "resizing") return "Preparing photo…";
  if (state.kind === "uploading") return "Uploading…";
  if (state.kind === "analyzing") return "Analyzing…";
  if (state.kind === "done") return "Take another photo";
  return override ?? "Take a photo";
}

async function uploadOnce(
  blob: Blob,
  args: { cook_session_id: string; member_id: string; task_id: string | null },
): Promise<{ photo_id: string; vision_pending: boolean; analysis?: unknown } | null> {
  const url = new URL("/api/cook/photo-upload", window.location.origin);
  url.searchParams.set("cook_session_id", args.cook_session_id);
  url.searchParams.set("member_id", args.member_id);
  if (args.task_id) url.searchParams.set("task_id", args.task_id);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": blob.type || "image/jpeg" },
    body: blob,
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as {
      photo_id: string;
      vision_pending: boolean;
      analysis?: unknown;
    };
  } catch {
    return null;
  }
}

function CameraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-6 w-6"
      aria-hidden
    >
      <path d="M3 7h3l2-3h8l2 3h3v13H3z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
