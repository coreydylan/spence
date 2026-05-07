import type { Meta, StoryObj } from "@storybook/react";
import { ShopItemRow } from "@/app/shop/components/shop-item-row";

const meta: Meta<typeof ShopItemRow> = {
  title: "Shop/ShopItemRow",
  component: ShopItemRow,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ShopItemRow>;

export const Unchecked: Story = {
  args: {
    shopRunId: "demo_run_1",
    name: "Asparagus",
    qty: 700,
    unit: "g",
  },
};

export const NoQty: Story = {
  args: {
    shopRunId: "demo_run_1",
    name: "Lemons",
    qty: null,
    unit: null,
  },
};

export const ClovesOfGarlic: Story = {
  args: {
    shopRunId: "demo_run_1",
    name: "Garlic",
    qty: 7,
    unit: "clove",
  },
};
