import type { Meta, StoryObj } from "@storybook/react";
import { WeatherStrip } from "@/components/meal/weather-strip";

const meta: Meta<typeof WeatherStrip> = {
  title: "Meal/WeatherStrip",
  component: WeatherStrip,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof WeatherStrip>;

export const Mild: Story = {
  args: {
    conditions: "partly_cloudy",
    high_f: 74,
    low_f: 55,
    pattern_summary: "Mild and dry. Good day for grill or oven.",
  },
};

export const Hot: Story = {
  args: {
    conditions: "sunny",
    high_f: 94,
    low_f: 68,
    pattern_summary: "Hot start. Skip the oven; grill or eat cold.",
  },
};

export const Rainy: Story = {
  args: {
    conditions: "rainy",
    high_f: 58,
    low_f: 45,
    pattern_summary: "Cold and wet. Stew weather.",
  },
};

export const Empty: Story = {
  args: {
    conditions: null,
    high_f: null,
    low_f: null,
    pattern_summary: null,
  },
};
