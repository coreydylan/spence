import type { Meta, StoryObj } from "@storybook/react";
import { FirstHelpStep } from "@/app/onboarding/steps/first-help";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof FirstHelpStep> = {
  title: "Onboarding/FirstHelp",
  component: FirstHelpStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof FirstHelpStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="first_help" cta={cta} noAnimate onBack={() => {}}>
        <FirstHelpStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(v)}
        />
      </StepShell>
    </div>
  );
}

export const Default: Story = { render: () => <Frame /> };
export const WithSelection: Story = {
  render: () => <Frame initialValue="weekly_plan" />,
};
