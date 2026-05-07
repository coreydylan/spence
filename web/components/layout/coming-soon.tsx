import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";

interface Props {
  screen: string;
  phase: string;
}

/** Placeholder for routes not yet built. Phase 2+ agents replace these. */
export function ComingSoon({ screen, phase }: Props) {
  return (
    <div className="max-w-xl mx-auto px-5 pt-12">
      <Card>
        <CardContent className="p-8 flex flex-col gap-3">
          <Badge tone="terracotta">{phase}</Badge>
          <h1 className="font-serif text-3xl text-ink">
            {screen} is coming.
          </h1>
          <p className="text-ink-soft leading-relaxed">
            For now, head to{" "}
            <a href="/chat" className="text-terracotta underline underline-offset-4">
              the chat
            </a>{" "}
            and ask Spence anything. Every screen here is just a view onto the
            same conversation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
