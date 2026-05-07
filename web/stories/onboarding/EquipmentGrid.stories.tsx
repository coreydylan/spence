import type { Meta, StoryObj } from "@storybook/react";
import { EquipmentGridStep } from "@/app/onboarding/steps/equipment-grid";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof EquipmentGridStep> = {
  title: "Onboarding/EquipmentGrid",
  component: EquipmentGridStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof EquipmentGridStep>;

function Frame({ initialValue }: { initialValue?: string[] }) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="equipment_grid" cta={cta} noAnimate onBack={() => {}}>
        <EquipmentGridStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(JSON.stringify(v))}
          onSkip={() => alert("skipped")}
        />
      </StepShell>
    </div>
  );
}

export const Default: Story = { render: () => <Frame /> };
export const Loaded: Story = {
  render: () => (
    <Frame initialValue={["oven", "stovetop", "instant_pot", "cast_iron", "wok"]} />
  ),
};
