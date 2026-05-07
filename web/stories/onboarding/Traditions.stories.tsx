import type { Meta, StoryObj } from "@storybook/react";
import { TraditionsStep } from "@/app/onboarding/steps/traditions";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof TraditionsStep> = {
  title: "Onboarding/Traditions",
  component: TraditionsStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof TraditionsStep>;

function Frame({
  initialValue,
}: {
  initialValue?: { name: string; cadence: string }[];
}) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="traditions" cta={cta} noAnimate onBack={() => {}}>
        <TraditionsStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(JSON.stringify(v))}
          onSkip={() => alert("skipped")}
        />
      </StepShell>
    </div>
  );
}

export const Empty: Story = { render: () => <Frame /> };
export const FridayPizza: Story = {
  render: () => (
    <Frame
      initialValue={[{ name: "Friday pizza night", cadence: "weekly:friday" }]}
    />
  ),
};
