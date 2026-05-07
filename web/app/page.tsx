import Link from "next/link";
import { Button } from "@/components/primitives/button";
import { Card, CardContent } from "@/components/primitives/card";

export default function Landing() {
  return (
    <div className="max-w-3xl mx-auto px-5 pt-12 md:pt-24 pb-12">
      <section className="flex flex-col gap-6">
        <p className="text-sm uppercase tracking-widest text-terracotta font-medium">
          Hi, I&apos;m Spence
        </p>
        <h1 className="font-serif text-5xl md:text-7xl leading-[0.95] text-ink">
          Your chef-of-staff,
          <br />
          on your phone.
        </h1>
        <p className="text-lg md:text-xl text-ink-soft max-w-xl leading-relaxed">
          I plan your week. I tell you when to start cooking. I learn what you
          actually like. And I never make you fill out a form.
        </p>

        <div className="flex flex-wrap gap-3 mt-2">
          <Link href="/chat">
            <Button size="lg">Start chatting</Button>
          </Link>
          <Link href="/today">
            <Button size="lg" variant="outline">
              See today
            </Button>
          </Link>
        </div>
      </section>

      <section className="grid md:grid-cols-3 gap-4 mt-16">
        <Feature
          title="Conversational"
          body="Chat is the front door. Every screen — your plan, a recipe, the shopping list — is an artifact of a conversation."
        />
        <Feature
          title="Progressive"
          body="Three questions on day one. A few more in week one. I learn by watching, not by interrogating."
        />
        <Feature
          title="Identity-led"
          body="Big quiet numbers. Earthy palette. Photographs of food. No dashboards-of-dashboards."
        />
      </section>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-5">
        <h3 className="font-serif text-xl text-ink">{title}</h3>
        <p className="text-sm text-ink-soft leading-relaxed">{body}</p>
      </CardContent>
    </Card>
  );
}
