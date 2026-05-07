import type { Meta, StoryObj } from "@storybook/react";
import { DinnerRitualStep } from "@/app/onboarding/steps/dinner-ritual";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof DinnerRitualStep> = {
  title: "Onboarding/DinnerRitual",
  component: DinnerRitualStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof DinnerRitualStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="dinner_ritual" cta={cta} noAnimate onBack={() => {}}>
        <DinnerRitualStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(v)}
        />
      </StepShell>
    </div>
  );
}

export const Default: Story = { render: () => <Frame /> };
export const TableSelected: Story = {
  render: () => <Frame initialValue="table" />,
};
