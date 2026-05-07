import type { Meta, StoryObj } from "@storybook/react";
import { PantryItemRow } from "@/app/pantry/components/pantry-item-row";

const meta: Meta<typeof PantryItemRow> = {
  title: "Pantry/PantryItemRow",
  component: PantryItemRow,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PantryItemRow>;

export const Tier1Expiring: Story = {
  args: {
    name: "Asparagus",
    qty: 700,
    unit: "g",
    tier: 1,
    expiringSoon: true,
  },
};

export const Tier2: Story = {
  args: {
    name: "Feta",
    qty: 300,
    unit: "g",
    tier: 2,
  },
};

export const Tier3NoQty: Story = {
  args: {
    name: "Calabrian chili paste",
    qty: null,
    unit: null,
    tier: 3,
  },
};
