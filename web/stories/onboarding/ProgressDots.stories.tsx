import type { Meta, StoryObj } from "@storybook/react";
import { ProgressDots } from "@/components/onboarding/progress-dots";

const meta: Meta<typeof ProgressDots> = {
  title: "Onboarding/ProgressDots",
  component: ProgressDots,
  parameters: { layout: "centered", backgrounds: { default: "cream" } },
};
export default meta;
type Story = StoryObj<typeof ProgressDots>;

const groups = [
  { tier: 0 as const, total: 5, index: 2 },
  { tier: 1 as const, total: 5, index: -1 },
  { tier: "bulk" as const, total: 3, index: -1 },
];

export const Tier0Mid: Story = {
  args: { groups, activeTier: 0 },
};

export const Tier1Start: Story = {
  args: {
    groups: [
      { tier: 0, total: 5, index: 4 },
      { tier: 1, total: 5, index: 0 },
      { tier: "bulk", total: 3, index: -1 },
    ],
    activeTier: 1,
  },
};

export const BulkMid: Story = {
  args: {
    groups: [
      { tier: 0, total: 5, index: 4 },
      { tier: 1, total: 5, index: 4 },
      { tier: "bulk", total: 3, index: 1 },
    ],
    activeTier: "bulk",
  },
};
