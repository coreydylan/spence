import type { Meta, StoryObj } from "@storybook/react";
import { IngredientChip } from "@/components/meal/ingredient-chip";

const meta: Meta<typeof IngredientChip> = {
  title: "Meal/IngredientChip",
  component: IngredientChip,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <ul className="max-w-md flex flex-col bg-white p-4 rounded-md">
        <Story />
      </ul>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof IngredientChip>;

export const SimpleQty: Story = {
  args: { name: "jasmine rice", qty: 300, unit: "g" },
};

export const NumberOnly: Story = {
  args: { name: "garlic", qty: 4, unit: "clove" },
};

export const WithPrep: Story = {
  args: {
    name: "firm tofu",
    qty: 400,
    unit: "g",
    prep: "pressed and cubed",
  },
};

export const Optional: Story = {
  args: {
    name: "scallions",
    qty: 2,
    unit: "stalks",
    importance: "optional",
  },
};

export const NoQty: Story = {
  args: { name: "olive oil to coat" },
};
