"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Input } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";

export interface LocationStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function LocationStep({
  initialValue = "",
  onSubmit,
  bindCta,
}: LocationStepProps) {
  const [value, setValue] = React.useState(initialValue);
  const [detecting, setDetecting] = React.useState(false);
  const [detectError, setDetectError] = React.useState<string | null>(null);

  const submit = React.useCallback(() => {
    const v = value.trim();
    if (v) onSubmit(v);
  }, [value, onSubmit]);

  React.useEffect(() => {
    bindCta?.(
      <Button
        size="lg"
        onClick={submit}
        disabled={!value.trim()}
        className="w-full"
      >
        Continue
      </Button>,
    );
  }, [bindCta, submit, value]);

  const detect = () => {
    if (!("geolocation" in navigator)) {
      setDetectError("Your browser doesn't support location detection.");
      return;
    }
    setDetecting(true);
    setDetectError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDetecting(false);
        // We don't reverse-geocode here — keep the UI promise-light. We send
        // raw coordinates as the answer; the worker can resolve city if needed.
        const coords = `${pos.coords.latitude.toFixed(3)},${pos.coords.longitude.toFixed(3)}`;
        setValue(coords);
      },
      (err) => {
        setDetecting(false);
        setDetectError(err.message || "Couldn't read location.");
      },
      { timeout: 8000 },
    );
  };

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Step 3"
        title="Where do you cook?"
        subhead="Just a city or zip — I use this for seasonality and weather. No precise address needed."
      />

      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. San Diego, CA or 92101"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <button
          type="button"
          onClick={detect}
          disabled={detecting}
          className="self-start text-sm text-terracotta hover:underline disabled:opacity-50"
        >
          {detecting ? "Detecting…" : "Or let me detect it"}
        </button>

        {detectError && (
          <p className="text-xs text-amber" role="alert">
            {detectError}
          </p>
        )}
      </div>
    </div>
  );
}
