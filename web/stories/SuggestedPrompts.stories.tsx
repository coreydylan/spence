import type { Meta, StoryObj } from "@storybook/react";
import { SuggestedPrompts } from "@/components/chat/suggested-prompts";

const meta: Meta<typeof SuggestedPrompts> = {
  title: "Chat/SuggestedPrompts",
  component: SuggestedPrompts,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof SuggestedPrompts>;

export const Default: Story = {
  args: {
    onPick: (text: string) => console.log("picked:", text),
  },
};

export const CustomPrompts: Story = {
  args: {
    headline: "Welcome back, friend.",
    subhead: "Three things on the menu tonight:",
    prompts: [
      { id: "1", text: "What's quick?" },
      { id: "2", text: "Pasta tonight" },
      { id: "3", text: "Use the pork shoulder" },
    ],
    onPick: (text: string) => console.log("picked:", text),
  },
};
