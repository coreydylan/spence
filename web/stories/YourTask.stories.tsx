import type { Meta, StoryObj } from "@storybook/react";
import { YourTask } from "@/app/cook/[cook_session_id]/active/your-task";

const meta: Meta<typeof YourTask> = {
  title: "Cook/YourTask",
  component: YourTask,
  parameters: {
    layout: "padded",
    backgrounds: { default: "kitchen" },
  },
  decorators: [
    (Story) => (
      <div className="cook-bg p-6 min-h-[400px] max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    onAck: () => {},
    onComplete: () => {},
    onRequestHelp: () => {},
    onDecline: () => {},
  },
};
export default meta;
type Story = StoryObj<typeof YourTask>;

export const Idle: Story = {
  args: { state: { kind: "idle" } },
};

export const Active: Story = {
  args: {
    state: {
      kind: "active",
      task_id: "task_cube_tofu",
      title: "Cube tofu, dredge in cornstarch",
      detail: "Pat dry first — wet tofu won't crisp. Aim for 3/4-inch cubes.",
      est_min: 5,
      equipment: "stove burner 1",
      acked: false,
    },
  },
};

export const ActiveAcked: Story = {
  args: {
    state: {
      kind: "active",
      task_id: "task_cube_tofu",
      title: "Cube tofu, dredge in cornstarch",
      est_min: 5,
      equipment: "stove burner 1",
      acked: true,
    },
  },
};

export const Awaiting: Story = {
  args: {
    state: {
      kind: "awaiting",
      task_id: "task_cube_tofu",
      title: "Cube tofu, dredge in cornstarch",
    },
  },
};

export const Done: Story = {
  args: {
    state: {
      kind: "done",
      task_id: "task_cube_tofu",
      title: "Cube tofu, dredge in cornstarch",
    },
  },
};
