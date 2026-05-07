import type { Meta, StoryObj } from "@storybook/react";
import { RecipeTimeline } from "@/app/cook/[cook_session_id]/active/recipe-timeline";

const meta: Meta<typeof RecipeTimeline> = {
  title: "Cook/RecipeTimeline",
  component: RecipeTimeline,
  decorators: [
    (Story) => (
      <div className="cook-bg p-6 min-h-[500px] max-w-xl">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RecipeTimeline>;

export const InProgress: Story = {
  args: {
    steps: [
      {
        task_id: "t1",
        scheduled_at: "17:00",
        title: "Press tofu (15 min)",
        status: "completed",
        member_display_name: "Katrina",
      },
      {
        task_id: "t2",
        scheduled_at: "17:15",
        title: "Start jasmine rice in cooker",
        status: "completed",
        member_display_name: "Corey",
      },
      {
        task_id: "t3",
        scheduled_at: "17:20",
        title: "Cube tofu, dredge in cornstarch",
        status: "active",
        est_min: 5,
        member_display_name: "You",
      },
      {
        task_id: "t4",
        scheduled_at: "17:25",
        title: "Whisk Tso sauce",
        status: "pending",
        est_min: 4,
      },
      {
        task_id: "t5",
        scheduled_at: "17:30",
        title: "Fry tofu in batches",
        status: "pending",
        est_min: 8,
      },
      {
        task_id: "t6",
        scheduled_at: "17:40",
        title: "Sauté broccoli",
        status: "pending",
        est_min: 5,
      },
    ],
  },
};

export const FreshStart: Story = {
  args: {
    steps: [
      {
        task_id: "t1",
        scheduled_at: "18:00",
        title: "Mise en place",
        status: "active",
        est_min: 10,
      },
      {
        task_id: "t2",
        scheduled_at: "18:10",
        title: "Sauté aromatics",
        status: "pending",
        est_min: 4,
      },
      {
        task_id: "t3",
        scheduled_at: "18:14",
        title: "Add stock and simmer",
        status: "pending",
        est_min: 20,
      },
    ],
  },
};
