import { Card, CardContent } from "@/components/primitives/card";

export function EmptyInbox() {
  return (
    <Card>
      <CardContent className="p-8 flex flex-col gap-2">
        <h2 className="font-serif text-2xl text-ink">Quiet so far.</h2>
        <p className="text-ink-soft leading-relaxed">
          The morning brief fires once a day. As soon as Spence has something
          to say, you&apos;ll see it here — tonight&apos;s dinner, the day&apos;s
          weather, anything that conflicts with your calendar.
        </p>
      </CardContent>
    </Card>
  );
}
