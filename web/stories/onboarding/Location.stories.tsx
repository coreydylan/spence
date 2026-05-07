import type { Meta, StoryObj } from "@storybook/react";
import { LocationStep } from "@/app/onboarding/steps/location";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof LocationStep> = {
  title: "Onboarding/Location",
  component: LocationStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof LocationStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="location" cta={cta} noAnimate onBack={() => {}}>
        <LocationStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(v)}
        />
      </StepShell>
    </div>
  );
}

export const Empty: Story = { render: () => <Frame /> };
export const Filled: Story = { render: () => <Frame initialValue="San Diego, CA" /> };
