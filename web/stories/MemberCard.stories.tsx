import type { Meta, StoryObj } from "@storybook/react";
import { MemberCard } from "@/app/members/components/member-card";
import type { HouseholdMember, TraitSpread } from "@/lib/mcp";

const meta: Meta<typeof MemberCard> = {
  title: "Members/MemberCard",
  component: MemberCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof MemberCard>;

const member: HouseholdMember = {
  member_id: "mem_corey",
  household_id: "hh_demo",
  display_name: "Corey",
  age_group: "adult",
  dietary: ["vegetarian"],
  preferences: { loves: [], dislikes: [], allergies: [] },
  safety: {
    stove_authorized: true,
    oven_authorized: true,
    knife_authorized: true,
    heavy_lift_authorized: true,
    sharp_oils_authorized: true,
    minimum_supervision: "none",
  },
  skills: [
    { skill_name: "knife_skills", confidence: 0.7, tasks_completed: 12, last_used_at: null, speed_multiplier: 1.0 },
    { skill_name: "saute", confidence: 0.6, tasks_completed: 9, last_used_at: null, speed_multiplier: 0.95 },
  ],
  active_skill_quests: [],
  privacy: { share_skills_with_household: true, share_tastes_with_household: true },
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

const spreads: TraitSpread[] = [
  {
    trait_name: "comfort_vs_adventure",
    household_value: 0.5,
    household_confidence: 0.6,
    member_values: [{ member_id: "mem_corey", value: 0.2, confidence: 0.7 }],
    divergence: 0.65,
    status: "diverging",
    description: "Corey leans comfort, Katrina leans adventure.",
  },
  {
    trait_name: "spice_tolerance",
    household_value: 0.7,
    household_confidence: 0.5,
    member_values: [{ member_id: "mem_corey", value: 0.55, confidence: 0.6 }],
    divergence: 0.2,
    status: "aligned",
    description: "Both lean medium-hot.",
  },
];

export const WithTraits: Story = {
  args: { member, traitSpreads: spreads, linkToDetail: false },
};

export const Bare: Story = {
  args: {
    member: { ...member, dietary: [], skills: [] },
    traitSpreads: [],
    linkToDetail: false,
  },
};

export const Kid: Story = {
  args: {
    member: {
      ...member,
      member_id: "mem_kid",
      display_name: "Felix",
      age_group: "kid",
      dietary: [],
      skills: [
        { skill_name: "wash_produce", confidence: 0.9, tasks_completed: 30, last_used_at: null, speed_multiplier: 0.8 },
      ],
    },
    traitSpreads: [],
    linkToDetail: false,
  },
};
