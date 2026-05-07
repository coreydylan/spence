import type { Meta, StoryObj } from "@storybook/react";
import { VoiceInputStub } from "@/components/chat/voice-input-stub";
import { ToastProvider } from "@/components/system/toast-provider";

const meta: Meta<typeof VoiceInputStub> = {
  title: "Chat/VoiceInputStub",
  component: VoiceInputStub,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof VoiceInputStub>;

export const Default: Story = {
  args: {},
};

export const Disabled: Story = {
  args: { disabled: true },
};
