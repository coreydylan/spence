import type { Meta, StoryObj } from "@storybook/react";
import { TraitBar } from "@/app/members/components/trait-bar";

const meta: Meta<typeof TraitBar> = {
  title: "Members/TraitBar",
  component: TraitBar,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof TraitBar>;

export const HighConfidenceLow: Story = {
  args: { name: "comfort_vs_adventure", value: 0.2, confidence: 0.9 },
};

export const HighConfidenceHigh: Story = {
  args: { name: "comfort_vs_adventure", value: 0.85, confidence: 0.9 },
};

export const Centered: Story = {
  args: { name: "spice_tolerance", value: 0.5, confidence: 0.6 },
};

export const Preliminary: Story = {
  args: { name: "novelty_appetite", value: 0.45, confidence: 0.15 },
};

export const Compact: Story = {
  args: { name: "cooking_ambition", value: 0.62, confidence: 0.75, compact: true },
};
