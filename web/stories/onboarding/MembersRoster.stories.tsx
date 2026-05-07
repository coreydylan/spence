import type { Meta, StoryObj } from "@storybook/react";
import { MembersRosterStep } from "@/app/onboarding/steps/members-roster";
import { StepShell } from "@/components/onboarding/step-shell";
import * as React from "react";

const meta: Meta<typeof MembersRosterStep> = {
  title: "Onboarding/MembersRoster",
  component: MembersRosterStep,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof MembersRosterStep>;

function Frame({
  initialValue,
}: {
  initialValue?: { name: string; age_group?: string }[];
}) {
  const [cta, setCta] = React.useState<React.ReactNode>(null);
  return (
    <div className="onboarding-bg min-h-dvh">
      <StepShell animationKey="members" cta={cta} noAnimate onBack={() => {}}>
        <MembersRosterStep
          initialValue={initialValue}
          bindCta={setCta}
          onSubmit={(v) => alert(JSON.stringify(v))}
        />
      </StepShell>
    </div>
  );
}

export const Empty: Story = { render: () => <Frame /> };
export const WithMembers: Story = {
  render: () => (
    <Frame
      initialValue={[
        { name: "Katrina", age_group: "adult" },
        { name: "Pico", age_group: "kid" },
      ]}
    />
  ),
};
