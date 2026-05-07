"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import { tapHaptic } from "@/lib/haptics";
import { useToastOptional } from "@/components/system/toast-provider";

interface VoiceInputStubProps {
  /** Called with finalized transcript once voice is wired. Currently never invoked. */
  onTranscript?: (text: string) => void;
  className?: string;
  disabled?: boolean;
}

/**
 * VoiceInputStub — placeholder mic button next to the chat send button.
 *
 * Phase 6 will wire the real Web Speech `SpeechRecognition` flow. For now,
 * pressing the mic shows a "coming soon" toast (or alert fallback) and the
 * actual handler is documented inline below as a TODO with the API contract
 * intact.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Wiring outline (TODO — Phase 6):
 *
 *   const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
 *   recognition.lang = "en-US";
 *   recognition.continuous = false;
 *   recognition.interimResults = true;
 *   recognition.onresult = (e) => {
 *     const t = Array.from(e.results).map(r => r[0].transcript).join("");
 *     onTranscript?.(t);
 *   };
 *   recognition.onend = () => setListening(false);
 *   recognition.start();
 *
 * Feature-detect first: `'SpeechRecognition' in window || 'webkitSpeechRecognition' in window`.
 * On iOS Safari, requires user gesture — this button click is the gesture.
 * ──────────────────────────────────────────────────────────────────────────
 */
export function VoiceInputStub({ onTranscript: _onTranscript, className, disabled }: VoiceInputStubProps) {
  const toast = useToastOptional();

  const handleClick = () => {
    tapHaptic();
    if (toast) {
      toast.info("Voice input is coming soon", { durationMs: 2500 });
    } else if (typeof window !== "undefined") {
      // Fallback when not wrapped in a ToastProvider
      // (tests, isolated stories, etc.)
      // eslint-disable-next-line no-alert
      window.alert("Voice input is coming soon");
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label="Voice input (coming soon)"
      title="Voice input (coming soon)"
      className={cn(
        "inline-flex items-center justify-center h-11 w-11 shrink-0 rounded-[var(--radius-full)]",
        "bg-cream-deep dark:bg-ink-soft/30 text-ink-soft hover:text-ink hover:bg-cream-deep/80",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
    >
      <MicIcon />
    </button>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" strokeLinecap="round" />
    </svg>
  );
}
