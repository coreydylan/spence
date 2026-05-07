import * as React from "react";

export default function MembersLayout({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl mx-auto px-4 pt-6 pb-12">{children}</div>;
}
