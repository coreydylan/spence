import type { Meta, StoryObj } from "@storybook/react";
import { OtherMembers } from "@/app/cook/[cook_session_id]/active/other-members";

const meta: Meta<typeof OtherMembers> = {
  title: "Cook/OtherMembers",
  component: OtherMembers,
  decorators: [
    (Story) => (
      <div className="cook-bg p-6 min-h-[200px] max-w-xl">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof OtherMembers>;

export const Mixed: Story = {
  args: {
    members: [
      {
        member_id: "mem_katrina",
        display_name: "Katrina",
        presence: "busy_assigned",
        current_task_title: "Press tofu",
      },
      {
        member_id: "mem_corey",
        display_name: "Corey",
        presence: "in_kitchen_idle",
      },
      {
        member_id: "mem_jamie",
        display_name: "Jamie",
        presence: "stepped_away",
      },
    ],
  },
};

export const Empty: Story = {
  args: { members: [] },
};

export const Solo: Story = {
  args: {
    members: [
      {
        member_id: "mem_katrina",
        display_name: "Katrina",
        presence: "in_kitchen_idle",
      },
    ],
  },
};
