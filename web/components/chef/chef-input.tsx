"use client";

import * as React from "react";
import { Textarea } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";
import { cn } from "@/lib/cn";

interface ChefInputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * ChefInput — chat composer at the bottom of the chat surface.
 * Auto-grows up to ~6 lines, submits on Enter (Shift+Enter for newline).
 *
 * TODO(phase-6): voice mode. The mic button slot is reserved on the right.
 */
export function ChefInput({
  onSubmit,
  disabled,
  placeholder = "Ask Spence anything…",
  className,
}: ChefInputProps) {
  const [value, setValue] = React.useState("");
  const ref = React.useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = Math.min(ref.current.scrollHeight, 180) + "px";
    }
  };

  return (
    <div className={cn("flex items-end gap-2 p-3 bg-cream/95 backdrop-blur border-t border-ink/5", className)}>
      <Textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 min-h-11 max-h-44 py-3"
      />
      {/* TODO(voice): mic button toggles SpeechRecognition session */}
      <Button
        type="button"
        variant="primary"
        size="md"
        onClick={submit}
        disabled={disabled || !value.trim()}
        aria-label="Send"
      >
        Send
      </Button>
    </div>
  );
}
