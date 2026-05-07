import type { Meta, StoryObj } from "@storybook/react";
import { NewMessagePill } from "@/components/chat/new-message-pill";

const meta: Meta<typeof NewMessagePill> = {
  title: "Chat/NewMessagePill",
  component: NewMessagePill,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof NewMessagePill>;

export const Visible: Story = {
  args: {
    visible: true,
    onClick: () => console.log("scrolling to bottom"),
  },
  render: (args) => (
    <div className="relative h-64 w-full bg-cream-deep/40 rounded-md">
      <NewMessagePill {...args} />
    </div>
  ),
};

export const Hidden: Story = {
  args: { visible: false, onClick: () => {} },
  render: (args) => (
    <div className="relative h-64 w-full bg-cream-deep/40 rounded-md flex items-center justify-center text-ink-soft">
      (hidden — visible=false)
      <NewMessagePill {...args} />
    </div>
  ),
};
