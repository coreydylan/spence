import * as React from "react";

/**
 * /today layout — keeps the mounted shell from app/layout.tsx but applies
 * the page-level vertical rhythm (max-width column + breathing room).
 */
export default function TodayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto px-5 md:px-8 pt-6 md:pt-12 pb-12">
      {children}
    </div>
  );
}
