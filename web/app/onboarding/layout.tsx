import * as React from "react";

/**
 * Onboarding layout — full-screen, no top bar, no tab bar.
 *
 * The root layout (`app/layout.tsx`) wraps every page in `<Shell>` (which
 * mounts the chef wordmark header + tab bar). For onboarding we want a
 * clean canvas: no header, no nav, just the question. We achieve that by
 * absolutely-positioning this layer over the shell with `fixed inset-0`
 * and `z-50` — covers the shell while the wizard is mounted.
 */
export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 onboarding-bg overflow-y-auto">
      {children}
    </div>
  );
}
