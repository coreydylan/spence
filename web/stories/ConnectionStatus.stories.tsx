import type { Meta, StoryObj } from "@storybook/react";
import { ConnectionStatusBadge } from "@/app/cook/[cook_session_id]/active/connection-status";

const meta: Meta<typeof ConnectionStatusBadge> = {
  title: "Cook/ConnectionStatus",
  component: ConnectionStatusBadge,
  decorators: [
    (Story) => (
      <div className="cook-bg p-6 min-h-[120px] flex items-start justify-start">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ConnectionStatusBadge>;

export const Connected: Story = { args: { status: "connected" } };
export const Connecting: Story = { args: { status: "connecting" } };
export const Reconnecting: Story = {
  args: { status: "reconnecting", detail: "attempt 3, delay_ms=2400" },
};
export const Disconnected: Story = {
  args: { status: "disconnected", detail: "code=1006" },
};
export const ErrorState: Story = {
  args: { status: "error", detail: "auth_failed" },
};
export const Closed: Story = { args: { status: "closed" } };
