import type { Meta, StoryObj } from "@storybook/react";
import { CookTimeline } from "@/app/recipe/[meal_id]/components/cook-timeline";

const meta: Meta<typeof CookTimeline> = {
  title: "Recipe/CookTimeline",
  component: CookTimeline,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof CookTimeline>;

export const Heuristic: Story = {
  args: {
    steps: [
      { time: "17:00", prose: "Press tofu (15 min); rinse rice.", source: "heuristic" },
      { time: "17:15", prose: "Start rice (jasmine, 18 min absorption).", source: "heuristic" },
      { time: "17:20", prose: "Cube tofu, dredge in cornstarch.", source: "heuristic" },
      { time: "17:35", prose: "Sear tofu over high heat for 6 minutes.", source: "heuristic" },
      { time: "17:45", prose: "Plate over rice, garnish. Eat.", source: "heuristic" },
    ],
  },
};

export const RealRecipeSteps: Story = {
  args: {
    steps: [
      {
        time: "17:00",
        prose: "Combine tahini, lemon juice, garlic, and ice water in a food processor.",
        source: "recipe_steps",
      },
      {
        time: "17:08",
        prose:
          "Add chickpeas and salt; blend until aggressively smooth, scraping the sides as needed.",
        source: "recipe_steps",
      },
      {
        time: "17:18",
        prose: "Plate, drizzle with olive oil, and dust with sumac.",
        source: "recipe_steps",
      },
    ],
  },
};

export const Empty: Story = {
  args: { steps: [] },
};
