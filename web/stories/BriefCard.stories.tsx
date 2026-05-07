import type { Meta, StoryObj } from "@storybook/react";
import { BriefCard } from "@/app/inbox/components/brief-card";
import type { MorningBrief } from "@/lib/mcp";

const meta: Meta<typeof BriefCard> = {
  title: "Inbox/BriefCard",
  component: BriefCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof BriefCard>;

const baseBrief: MorningBrief = {
  household_id: "hh_demo",
  date: "2026-05-07",
  generated_at_ms: Date.parse("2026-05-07T13:00:00Z"),
  weather: {
    location: { lat: 37.77, lng: -122.42, tz: "America/Los_Angeles" },
    forecast: [
      {
        date: "2026-05-07",
        high_f: 74,
        low_f: 55,
        conditions: "mild + dry",
        precip_chance: 0,
        wind_mph: 6,
        sunrise_local: "06:12",
        sunset_local: "20:08",
      },
    ],
    pattern_summary: "Mild and dry. Good day for grill or oven.",
    cooking_hints: ["Outdoor cooking is comfortable."],
  },
  calendar: [
    {
      date: "2026-05-07",
      busy_blocks: [
        { start: "2026-05-07T17:30:00Z", end: "2026-05-07T18:00:00Z", title: "School pickup" },
      ],
    },
  ],
  plan_health: [],
  suggestions: [
    {
      kind: "tight_window",
      message: "Tomorrow's mezze conflicts with a 5:30pm calendar block — start prep at 4.",
    },
  ],
  onboarding_question: null,
  notifications_summary: { count_by_kind: { tight_window: 1 } },
};

export const WithSuggestions: Story = { args: { brief: baseBrief } };

export const Quiet: Story = {
  args: {
    brief: { ...baseBrief, suggestions: [], calendar: [] },
  },
};

export const WithDailyQuestion: Story = {
  args: {
    brief: {
      ...baseBrief,
      onboarding_question: {
        prompt: "Tofu's shown up 4 times in 2 weeks — constant or phase?",
      },
    },
  },
};
