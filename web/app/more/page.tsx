import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";

interface MoreLink {
  href: string;
  label: string;
  blurb: string;
  icon: string;
}

const LINKS: MoreLink[] = [
  {
    href: "/pantry",
    label: "Pantry",
    blurb: "What's on the shelves, what's about to expire.",
    icon: "◐",
  },
  {
    href: "/members",
    label: "Household",
    blurb: "Who lives here, what they like, what they can do.",
    icon: "◑",
  },
  {
    href: "/inbox",
    label: "Inbox",
    blurb: "The morning brief, history.",
    icon: "◒",
  },
  {
    href: "/settings",
    label: "Settings",
    blurb: "Profile, traditions, equipment, notifications.",
    icon: "◓",
  },
  {
    href: "/about",
    label: "About",
    blurb: "What Spence is, version, build.",
    icon: "◔",
  },
];

/**
 * The "More" tab — a small directory to the management surfaces (pantry,
 * household, inbox). Settings will live here in Phase 6.
 */
export default function MorePage() {
  return (
    <div className="max-w-xl mx-auto px-4 pt-6 pb-12">
      <h1 className="font-serif text-4xl text-ink tracking-tight px-1">
        More
      </h1>
      <p className="text-ink-soft mt-1 px-1">
        The quieter parts of the kitchen.
      </p>

      <ul className="mt-6 flex flex-col gap-3">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="block hover:opacity-95 transition-opacity"
            >
              <Card>
                <CardContent className="p-5 flex items-center gap-4">
                  <span
                    aria-hidden
                    className="h-10 w-10 rounded-full bg-cream-deep text-terracotta text-xl flex items-center justify-center font-serif"
                  >
                    {l.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <h2 className="font-serif text-xl text-ink tracking-tight">
                      {l.label}
                    </h2>
                    <p className="text-sm text-ink-soft">{l.blurb}</p>
                  </div>
                  <span aria-hidden className="text-ink-soft">
                    ›
                  </span>
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
