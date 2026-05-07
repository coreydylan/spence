import type { Meta, StoryObj } from "@storybook/react";
import { EventLog } from "@/app/cook/[cook_session_id]/active/event-log";

const meta: Meta<typeof EventLog> = {
  title: "Cook/EventLog",
  component: EventLog,
  decorators: [
    (Story) => (
      <div className="cook-bg p-6 min-h-[300px] max-w-xl">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof EventLog>;

export const Empty: Story = { args: { events: [] } };

export const Mixed: Story = {
  args: {
    events: [
      {
        id: "1",
        time: "17:25",
        message: "Spence: Vision check OK — sear is good",
        tone: "system",
      },
      {
        id: "2",
        time: "17:24",
        message: "You ✓ Pressed tofu",
        tone: "ours",
      },
      {
        id: "3",
        time: "17:23",
        message: "Katrina: Press tofu",
      },
      {
        id: "4",
        time: "17:22",
        message: "Corey needs help: stuck on sauce ratios",
        tone: "warn",
      },
      {
        id: "5",
        time: "17:20",
        message: "Joined the brigade",
        tone: "system",
      },
    ],
  },
};
