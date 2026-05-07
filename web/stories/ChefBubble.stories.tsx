import type { Meta, StoryObj } from "@storybook/react";
import { ChefBubble } from "@/components/chef/chef-bubble";
import { ToolCallChip } from "@/components/chef/tool-call-chip";
import { MealCard } from "@/components/meal/meal-card";

const meta: Meta<typeof ChefBubble> = {
  title: "Chef/ChefBubble",
  component: ChefBubble,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ChefBubble>;

export const Typing: Story = {
  args: { typing: true },
};

export const ShortText: Story = {
  args: {
    children: "Tonight is donburi night — start cooking at 17:55.",
  },
};

export const WithToolCalls: Story = {
  args: {
    children: (
      <>
        <div className="flex gap-1.5">
          <ToolCallChip toolName="chef_status_check" status="done" />
          <ToolCallChip toolName="plan_compose_meal" status="running" />
        </div>
        <div>Here&apos;s what I&apos;m thinking for tonight…</div>
      </>
    ),
  },
};

export const WithMealCard: Story = {
  args: {
    children: (
      <>
        <div>Got it. Tonight:</div>
        <div className="-mx-2">
          <MealCard
            meal={{
              id: "m1",
              title: "General Tso tofu",
              format: "donburi",
              cuisine: "korean",
              serves: 2,
              active_minutes: 35,
              suggested_start_time: "17:55",
            }}
          />
        </div>
      </>
    ),
  },
};
