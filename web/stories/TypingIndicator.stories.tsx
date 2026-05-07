import type { Meta, StoryObj } from "@storybook/react";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { ChefBubble } from "@/components/chef/chef-bubble";

const meta: Meta<typeof TypingIndicator> = {
  title: "Chat/TypingIndicator",
  component: TypingIndicator,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof TypingIndicator>;

export const Default: Story = {
  args: {},
};

export const Inline: Story = {
  args: { inline: true },
};

export const InsideBubble: Story = {
  render: () => (
    <ChefBubble>
      <TypingIndicator inline />
    </ChefBubble>
  ),
};
