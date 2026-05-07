import type { Meta, StoryObj } from "@storybook/react";
import { AvoidancesStep } from "@/app/onboarding/steps/avoidances";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof AvoidancesStep> = {
  title: "Onboarding/Avoidances",
  component: AvoidancesStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof AvoidancesStep>;

function Frame({
  initialValue,
}: {
  initialValue?: { tags: string[]; free_text: string };
}) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="avoidances" cta={cta} noAnimate onBack={() => {}}>
        <AvoidancesStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(JSON.stringify(v))}
        />
      </StepShell>
    </div>
  );
}

export const Empty: Story = { render: () => <Frame /> };
export const Vegetarian: Story = {
  render: () => (
    <Frame
      initialValue={{ tags: ["vegetarian", "nut_free"], free_text: "no mushrooms" }}
    />
  ),
};
