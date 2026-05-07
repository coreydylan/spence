import { Card, CardContent, CardHeader, CardSubtitle, CardTitle } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";

/**
 * CalendarStubSection — placeholder for Google / iCloud calendar integration.
 *
 * The data we want here exists already (Track 3 reads calendar conflicts for
 * the morning brief), but the OAuth wiring is its own phase. For now: tell
 * the user it's coming, let Spence keep using the briefing-side conflicts.
 */
export function CalendarStubSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Calendar</CardTitle>
        <CardSubtitle>Spence avoids cooking through your meetings.</CardSubtitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 py-1.5">
          <span className="text-ink dark:text-cream">Google Calendar</span>
          <Badge tone="amber">coming soon</Badge>
        </div>
        <div className="flex items-center justify-between gap-3 py-1.5 border-t border-ink/5">
          <span className="text-ink dark:text-cream">iCloud Calendar</span>
          <Badge tone="amber">coming soon</Badge>
        </div>
        <p className="text-xs text-ink-soft dark:text-cream/60 mt-2 leading-relaxed">
          Until OAuth ships, mention conflicts inline in chat — Spence will work them
          into the plan.
        </p>
      </CardContent>
    </Card>
  );
}
