import type { Meta, StoryObj } from "@storybook/react";
import { RecipeHero } from "@/app/recipe/[meal_id]/components/recipe-hero";
import { Button } from "@/components/primitives/button";

const meta: Meta<typeof RecipeHero> = {
  title: "Recipe/RecipeHero",
  component: RecipeHero,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof RecipeHero>;

export const Donburi: Story = {
  args: {
    meal: {
      id: "m1",
      title: "General Tso tofu with broccoli over jasmine rice",
      format: "donburi",
      cuisine: "korean",
      serves: 2,
      method_summary: "Crisp tofu and broccoli in a sticky sweet-and-spicy glaze.",
    },
    active_minutes: 35,
    start_cooking_time: "17:55",
    eat_time: "18:30",
    cta: <Button size="lg">Start cooking →</Button>,
  },
};

export const Mezze: Story = {
  args: {
    meal: {
      id: "m2",
      title: "Spring asparagus mezze",
      format: "mezze",
      cuisine: "mediterranean",
      serves: 4,
      method_summary: "Five dishes, one table, no oven.",
    },
    active_minutes: 60,
    start_cooking_time: "16:30",
    eat_time: "17:30",
    cta: <Button size="lg">Start cooking →</Button>,
  },
};
