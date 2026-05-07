import type { Meta, StoryObj } from "@storybook/react";
import { EquipmentChip } from "@/components/meal/equipment-chip";

const meta: Meta<typeof EquipmentChip> = {
  title: "Meal/EquipmentChip",
  component: EquipmentChip,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof EquipmentChip>;

export const Idle: Story = {
  args: { slug: "stovetop_burner", status: "idle" },
};

export const Claimed: Story = {
  args: { slug: "rice_cooker", status: "claimed" },
};

export const Unavailable: Story = {
  args: { slug: "oven", status: "unavailable" },
};

export const Row: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 max-w-md">
      <EquipmentChip slug="stovetop_burner" />
      <EquipmentChip slug="rice_cooker" status="claimed" />
      <EquipmentChip slug="chef's knife" />
      <EquipmentChip slug="cutting_board" />
      <EquipmentChip slug="oven" status="unavailable" />
    </div>
  ),
};
