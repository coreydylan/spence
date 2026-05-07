import type { Meta, StoryObj } from "@storybook/react";
import { PrimaryMemberStep } from "@/app/onboarding/steps/primary-member";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof PrimaryMemberStep> = {
  title: "Onboarding/PrimaryMember",
  component: PrimaryMemberStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof PrimaryMemberStep>;

function Frame({
  initialValue,
}: {
  initialValue?: { name: string; age_group?: string };
}) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="primary_member" cta={cta} noAnimate onBack={() => {}}>
        <PrimaryMemberStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(JSON.stringify(v))}
        />
      </StepShell>
    </div>
  );
}

export const Empty: Story = {
  render: () => <Frame />,
};

export const Filled: Story = {
  render: () => <Frame initialValue={{ name: "Corey", age_group: "adult" }} />,
};
