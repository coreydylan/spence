import type { Meta, StoryObj } from "@storybook/react";
import { PantryPasteStep } from "@/app/onboarding/steps/pantry-paste";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof PantryPasteStep> = {
  title: "Onboarding/PantryPaste",
  component: PantryPasteStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof PantryPasteStep>;

function Frame({ initialValue }: { initialValue?: string }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="pantry_paste" cta={cta} noAnimate onBack={() => {}}>
        <PantryPasteStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(v)}
          onSkip={() => alert("skipped")}
        />
      </StepShell>
    </div>
  );
}

export const Empty: Story = { render: () => <Frame /> };
export const WithText: Story = {
  render: () => (
    <Frame
      initialValue={"chickpeas, lentils, jasmine rice\nolive oil, miso, tahini\ngarlic, lemons"}
    />
  ),
};
