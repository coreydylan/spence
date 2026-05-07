import type { Meta, StoryObj } from "@storybook/react";
import { CookFrequencyStep } from "@/app/onboarding/steps/cook-frequency";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof CookFrequencyStep> = {
  title: "Onboarding/CookFrequency",
  component: CookFrequencyStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof CookFrequencyStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="cook_frequency" cta={cta} noAnimate onBack={() => {}}>
        <CookFrequencyStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(v)}
        />
      </StepShell>
    </div>
  );
}

export const Default: Story = { render: () => <Frame /> };
export const MostNights: Story = {
  render: () => <Frame initialValue="most" />,
};
