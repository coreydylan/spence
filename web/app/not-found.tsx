import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Button } from "@/components/primitives/button";

/**
 * Global 404. Used for any route that doesn't resolve, including
 * /recipe/[meal_id] when the meal isn't found (the route's own page can
 * also call notFound()).
 */
export default function NotFound() {
  return (
    <div className="max-w-xl mx-auto px-5 pt-12">
      <Card>
        <CardContent className="p-8 flex flex-col gap-3">
          <h1 className="font-serif text-3xl text-ink dark:text-cream">
            Can&apos;t find that.
          </h1>
          <p className="text-ink-soft dark:text-cream/70 leading-relaxed">
            Either it never existed or it&apos;s already in the rotation. Either way —
            head to the chat and tell Spence what you&apos;re actually after.
          </p>
          <div className="flex gap-3 mt-2">
            <Link href="/chat">
              <Button variant="primary">Back to chat</Button>
            </Link>
            <Link href="/today">
              <Button variant="outline">Today</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
