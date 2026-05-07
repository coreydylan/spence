import type { Meta, StoryObj } from "@storybook/react";
import { FinalStep } from "@/app/onboarding/steps/final";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof FinalStep> = {
  title: "Onboarding/Final",
  component: FinalStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof FinalStep>;

function Frame() {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="final" cta={cta} noAnimate>
        <FinalStep
          bindCta={setCta}
          onDraftWeek={() => alert("drafting…")}
          onJustChat={() => alert("just chat")}
        />
      </StepShell>
    </div>
  );
}

export const Default: Story = { render: () => <Frame /> };
