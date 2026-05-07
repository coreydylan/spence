import type { Meta, StoryObj } from "@storybook/react";
import { PreferenceWarning } from "@/components/meal/preference-warning";

const meta: Meta<typeof PreferenceWarning> = {
  title: "Meal/PreferenceWarning",
  component: PreferenceWarning,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PreferenceWarning>;

export const Simple: Story = {
  args: {
    message: "Friday's plan conflicts with the household's weekly pizza night.",
  },
};

export const WithDetails: Story = {
  args: {
    title: "Heads up — back-to-back",
    message: "Two pasta dinners in three days.",
    details: [
      "Tuesday: cacio e pepe",
      "Thursday: bucatini with sausage",
    ],
  },
};

export const TraditionConflict: Story = {
  args: {
    title: "Tradition",
    message: "Sunday is usually slow-roast night — this plan has tacos.",
  },
};
