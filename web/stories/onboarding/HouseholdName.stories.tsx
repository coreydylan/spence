import type { Meta, StoryObj } from "@storybook/react";
import { HouseholdNameStep } from "@/app/onboarding/steps/household-name";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof HouseholdNameStep> = {
  title: "Onboarding/HouseholdName",
  component: HouseholdNameStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof HouseholdNameStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="household_name" cta={cta} noAnimate>
        <HouseholdNameStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(`Submitted: ${v}`)}
        />
      </StepShell>
    </div>
  );
}

export const Empty: Story = {
  render: () => <Frame />,
};

export const Filled: Story = {
  render: () => <Frame initialValue="The Bruins" />,
};
