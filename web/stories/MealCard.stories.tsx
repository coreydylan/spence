import type { Meta, StoryObj } from "@storybook/react";
import { MealCard } from "@/components/meal/meal-card";

const meta: Meta<typeof MealCard> = {
  title: "Meal/MealCard",
  component: MealCard,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof MealCard>;

export const Compact: Story = {
  args: {
    meal: {
      id: "m1",
      title: "General Tso tofu",
      format: "donburi",
      cuisine: "korean",
      serves: 2,
      active_minutes: 35,
      suggested_start_time: "17:55",
    },
  },
};

export const Hero: Story = {
  args: {
    variant: "hero",
    meal: {
      id: "m2",
      title: "Brown butter tahini cabbage",
      format: "sheet_pan",
      cuisine: "fusion",
      serves: 4,
      active_minutes: 25,
      total_minutes: 50,
    },
  },
};

export const WithConflict: Story = {
  args: {
    meal: {
      id: "m3",
      title: "Asparagus mezze",
      format: "grain_bowl",
      cuisine: "mediterranean",
      serves: 2,
      active_minutes: 30,
      suggested_start_time: "17:00",
      notes: ["conflicts with calendar event at 17:30"],
    },
  },
};

export const NoMeta: Story = {
  args: {
    meal: { id: "m4", title: "Something simple" },
  },
};

export const Pasta: Story = {
  args: {
    meal: {
      id: "m5",
      title: "Cacio e pepe",
      format: "pasta",
      cuisine: "italian",
      serves: 2,
      active_minutes: 20,
    },
  },
};
