import type { Meta, StoryObj } from "@storybook/react";
import { BriefDetail } from "@/app/inbox/components/brief-detail";
import type { MorningBrief } from "@/lib/mcp";

const meta: Meta<typeof BriefDetail> = {
  title: "Inbox/BriefDetail",
  component: BriefDetail,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof BriefDetail>;

const brief: MorningBrief = {
  household_id: "hh_demo",
  date: "2026-05-07",
  generated_at_ms: Date.parse("2026-05-07T13:00:00Z"),
  weather: {
    location: { lat: 37.77, lng: -122.42, tz: "America/Los_Angeles" },
    forecast: [
      { date: "2026-05-07", high_f: 74, low_f: 55, conditions: "mild + dry", precip_chance: 0, wind_mph: 6, sunrise_local: "06:12", sunset_local: "20:08" },
      { date: "2026-05-08", high_f: 72, low_f: 54, conditions: "partly cloudy", precip_chance: 10, wind_mph: 8, sunrise_local: "06:11", sunset_local: "20:09" },
      { date: "2026-05-09", high_f: 78, low_f: 58, conditions: "sunny", precip_chance: 0, wind_mph: 5, sunrise_local: "06:10", sunset_local: "20:10" },
    ],
    pattern_summary: "Mild + dry through the weekend. Good days for grill or oven.",
    cooking_hints: ["Outdoor cooking is comfortable.", "Berries are coming in season."],
  },
  calendar: [
    {
      date: "2026-05-07",
      busy_blocks: [{ start: "2026-05-07T17:30:00Z", end: "2026-05-07T18:00:00Z", title: "School pickup" }],
    },
  ],
  plan_health: [
    { plan_id: "plan_demo_1", hard_grievance_count: 0, warning_grievance_count: 1, missed_prep_today: [], headline_issue: "1 warning grievance" },
  ],
  suggestions: [
    { kind: "tight_window", message: "Tomorrow's mezze conflicts with a 5:30pm block — start prep at 4." },
    { kind: "shop_today", message: "Pick up asparagus + feta on the way home." },
    { kind: "expiring_soon", message: "Thai basil is 48h out — use it tonight." },
  ],
  onboarding_question: {
    prompt: "Tofu's shown up 4 times in 2 weeks — constant or phase?",
    choices: [
      { id: "constant", label: "It's a constant" },
      { id: "phase", label: "Phase" },
    ],
  },
  notifications_summary: { count_by_kind: { tight_window: 1, shop_today: 1, expiring_soon: 1 } },
};

export const Full: Story = { args: { brief } };

export const Minimal: Story = {
  args: {
    brief: {
      ...brief,
      weather: null,
      calendar: [],
      plan_health: [],
      suggestions: [],
      onboarding_question: null,
      notifications_summary: { count_by_kind: {} },
    },
  },
};
