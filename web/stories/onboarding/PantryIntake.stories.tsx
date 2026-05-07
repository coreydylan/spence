import type { Meta, StoryObj } from "@storybook/react";
import { PantryIntakeStep } from "@/app/onboarding/steps/pantry-intake";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof PantryIntakeStep> = {
  title: "Onboarding/PantryIntake",
  component: PantryIntakeStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof PantryIntakeStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="pantry_intake" cta={cta} noAnimate onBack={() => {}}>
        <PantryIntakeStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(v)}
        />
      </StepShell>
    </div>
  );
}

export const Default: Story = { render: () => <Frame /> };
export const BulkSelected: Story = {
  render: () => <Frame initialValue="bulk" />,
};
