import type { Meta, StoryObj } from "@storybook/react";
import { PerishTierSection } from "@/app/pantry/components/perish-tier";
import { PantryItemRow } from "@/app/pantry/components/pantry-item-row";

const meta: Meta<typeof PerishTierSection> = {
  title: "Pantry/PerishTier",
  component: PerishTierSection,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PerishTierSection>;

export const Tier1: Story = {
  args: {
    tier: 1,
    count: 3,
    children: [
      <PantryItemRow key="a" name="Asparagus" qty={700} unit="g" tier={1} expiringSoon />,
      <PantryItemRow key="b" name="Thai basil" qty={1} unit="bunch" tier={1} expiringSoon />,
      <PantryItemRow key="c" name="Salmon fillet" qty={400} unit="g" tier={1} expiringSoon />,
    ],
  },
};

export const Tier2: Story = {
  args: {
    tier: 2,
    count: 4,
    children: [
      <PantryItemRow key="a" name="Feta" qty={300} unit="g" tier={2} />,
      <PantryItemRow key="b" name="Firm tofu" qty={2} unit={null} tier={2} />,
      <PantryItemRow key="c" name="Greek yogurt" qty={500} unit="g" tier={2} />,
      <PantryItemRow key="d" name="Carrots" qty={5} unit={null} tier={2} />,
    ],
  },
};

export const Tier3: Story = {
  args: {
    tier: 3,
    count: 5,
    children: [
      <PantryItemRow key="a" name="Jasmine rice" qty={2} unit="kg" tier={3} />,
      <PantryItemRow key="b" name="Pasta" qty={500} unit="g" tier={3} />,
      <PantryItemRow key="c" name="Olive oil" qty={1} unit="L" tier={3} />,
      <PantryItemRow key="d" name="Calabrian chili paste" qty={null} unit={null} tier={3} />,
      <PantryItemRow key="e" name="Tahini" qty={1} unit="jar" tier={3} />,
    ],
  },
};
