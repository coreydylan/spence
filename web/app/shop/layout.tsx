import * as React from "react";

/** Shop section layout — soft cream background already applied at root. */
export default function ShopLayout({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl mx-auto px-4 pt-6 pb-12">{children}</div>;
}
