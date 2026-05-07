import type { Meta, StoryObj } from "@storybook/react";
import { MealCardHero } from "@/components/meal/meal-card-hero";

const meta: Meta<typeof MealCardHero> = {
  title: "Meal/MealCardHero",
  component: MealCardHero,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof MealCardHero>;

export const Tonight: Story = {
  args: {
    overline: "Tonight's dinner",
    meal: {
      id: "m1",
      title: "General Tso tofu with broccoli over jasmine rice",
      format: "donburi",
      cuisine: "korean",
      serves: 2,
      active_minutes: 35,
      suggested_start_time: "17:55",
    },
  },
};

export const WithConflict: Story = {
  args: {
    overline: "Tonight's dinner",
    conflict: true,
    meal: {
      id: "m2",
      title: "Spring asparagus mezze",
      format: "mezze",
      cuisine: "mediterranean",
      serves: 4,
      active_minutes: 60,
      suggested_start_time: "16:30",
    },
  },
};

export const NoStartTime: Story = {
  args: {
    overline: "Tomorrow's dinner",
    meal: {
      id: "m3",
      title: "Cacio e pepe",
      format: "pasta",
      cuisine: "italian",
      serves: 2,
      active_minutes: 20,
    },
  },
};
