import type { Meta, StoryObj } from "@storybook/react";
import { SizeStep } from "@/app/onboarding/steps/size";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof SizeStep> = {
  title: "Onboarding/Size",
  component: SizeStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof SizeStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="size" cta={cta} noAnimate onBack={() => {}}>
        <SizeStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(v)}
        />
      </StepShell>
    </div>
  );
}

export const Default: Story = { render: () => <Frame /> };
export const TwoSelected: Story = { render: () => <Frame initialValue="2" /> };
