"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

interface Tab {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const TABS: Tab[] = [
  { href: "/today", label: "Today", icon: <SunIcon /> },
  { href: "/plan", label: "Plan", icon: <CalendarIcon /> },
  { href: "/chat", label: "Chat", icon: <ChatIcon /> },
  { href: "/shop", label: "Shop", icon: <BasketIcon /> },
  { href: "/more", label: "More", icon: <DotsIcon /> },
];

/**
 * TabBar — bottom navigation, mobile only (md:hidden).
 * Highlights the active route. Five tabs total. Above md, the tab bar hides
 * and a side nav (Phase 2) takes over.
 */
export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 inset-x-0 z-30 md:hidden bg-cream/95 backdrop-blur border-t border-ink/5 pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex justify-between max-w-md mx-auto">
        {TABS.map((tab) => {
          const active =
            pathname === tab.href ||
            (tab.href !== "/" && pathname.startsWith(tab.href));
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium",
                  active ? "text-terracotta" : "text-ink-soft hover:text-ink",
                )}
              >
                <span className="h-5 w-5 flex items-center justify-center">{tab.icon}</span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Inline SVG icons (no icon-lib dependency)
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function BasketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
      <path d="M3 6h18l-2 13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L3 6zM8 6V4a4 4 0 0 1 8 0v2" />
    </svg>
  );
}
function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}
