import type { Meta, StoryObj } from "@storybook/react";
import { MessageGroup } from "@/components/chat/message-group";
import { ChefBubble } from "@/components/chef/chef-bubble";
import { UserBubble } from "@/components/chef/user-bubble";

const meta: Meta<typeof MessageGroup> = {
  title: "Chat/MessageGroup",
  component: MessageGroup,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof MessageGroup>;

export const SingleAssistant: Story = {
  render: () => (
    <MessageGroup role="assistant" isFirstInGroup isLastInGroup>
      <ChefBubble>Tonight: donburi.</ChefBubble>
    </MessageGroup>
  ),
};

export const StackedAssistant: Story = {
  render: () => (
    <div>
      <MessageGroup role="assistant" isFirstInGroup isLastInGroup={false}>
        <ChefBubble>Looking at your week now.</ChefBubble>
      </MessageGroup>
      <MessageGroup role="assistant" isFirstInGroup={false} isLastInGroup={false}>
        <ChefBubble>You said no pasta — got it.</ChefBubble>
      </MessageGroup>
      <MessageGroup role="assistant" isFirstInGroup={false} isLastInGroup>
        <ChefBubble>Here&apos;s tonight.</ChefBubble>
      </MessageGroup>
    </div>
  ),
};

export const Conversation: Story = {
  render: () => (
    <div>
      <MessageGroup role="user">
        <UserBubble>plan me dinners for the week</UserBubble>
      </MessageGroup>
      <MessageGroup role="assistant" isFirstInGroup isLastInGroup={false}>
        <ChefBubble>Got it — vegetarian, no pasta.</ChefBubble>
      </MessageGroup>
      <MessageGroup role="assistant" isFirstInGroup={false} isLastInGroup>
        <ChefBubble>Drafting now…</ChefBubble>
      </MessageGroup>
      <MessageGroup role="user">
        <UserBubble>and skip Tuesday — eating out</UserBubble>
      </MessageGroup>
    </div>
  ),
};
