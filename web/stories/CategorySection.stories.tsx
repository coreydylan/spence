import type { Meta, StoryObj } from "@storybook/react";
import { CategorySection } from "@/app/shop/components/category-section";

const meta: Meta<typeof CategorySection> = {
  title: "Shop/CategorySection",
  component: CategorySection,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof CategorySection>;

export const Produce: Story = {
  args: {
    shopRunId: "demo_run_1",
    category: "produce",
    items: [
      { name: "Asparagus", quantity: 700, unit: "g" },
      { name: "Broccoli", quantity: 400, unit: "g" },
      { name: "Garlic", quantity: 7, unit: "clove" },
      { name: "Lemons", quantity: 3, unit: null },
      { name: "Cilantro", quantity: 1, unit: "bunch" },
    ],
  },
};

export const DairyProtein: Story = {
  args: {
    shopRunId: "demo_run_1",
    category: "dairy_proteins",
    items: [
      { name: "Feta", quantity: 300, unit: "g" },
      { name: "Firm tofu", quantity: 800, unit: "g" },
      { name: "Eggs", quantity: 12, unit: null },
    ],
  },
};

export const Empty: Story = {
  args: {
    shopRunId: "demo_run_1",
    category: "spices",
    items: [],
  },
};
