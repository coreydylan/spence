import * as React from "react";

export default function RecipeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto px-5 md:px-8 pt-6 md:pt-12 pb-12">
      {children}
    </div>
  );
}
