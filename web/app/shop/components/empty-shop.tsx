import { Card, CardContent } from "@/components/primitives/card";

/**
 * Rendered when no plan exists or the active plan has zero shop runs / sections.
 * Soft, conversational nudge — Spence isn't broken, the user just hasn't planned yet.
 */
export function EmptyShop({ reason }: { reason?: string }) {
  return (
    <div className="max-w-xl mx-auto px-5 pt-10">
      <Card>
        <CardContent className="p-8 flex flex-col gap-3">
          <h2 className="font-serif text-2xl text-ink">No shopping list yet.</h2>
          <p className="text-ink-soft leading-relaxed">
            {reason === "no_plan" ? (
              <>You haven&apos;t composed a plan yet. </>
            ) : (
              <>Your plan doesn&apos;t need anything from the store right now. </>
            )}
            Head to{" "}
            <a
              href="/chat"
              className="text-terracotta underline underline-offset-4"
            >
              the chat
            </a>{" "}
            and ask Spence to draft a few dinners.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
