import * as React from "react";

/**
 * Cook-mode layout — full-screen dark, hides the app Shell.
 *
 * The root layout (`app/layout.tsx`) wraps every page in `<Shell>` (top bar
 * + bottom tab bar). For cook mode we want a clean, kitchen-readable canvas:
 * dark background, NO chrome, all the screen for the task. Same trick as
 * onboarding — `fixed inset-0 z-50` covers the shell while mounted.
 *
 * The dark palette is provided by the `cook-bg` class (defined in
 * `globals.css`). Both the pre-cook join screen and the active cook UI
 * inherit this surface.
 */
export default function CookLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 cook-bg overflow-y-auto">{children}</div>
  );
}
