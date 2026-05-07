import type { Meta, StoryObj } from "@storybook/react";
import { Toast } from "@/components/system/toast";
import { ToastProvider, useToast } from "@/components/system/toast-provider";
import { Button } from "@/components/primitives/button";

const meta: Meta<typeof Toast> = {
  title: "System/Toast",
  component: Toast,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof Toast>;

export const Info: Story = {
  args: {
    toast: {
      id: "1",
      tone: "info",
      message: "Spence is thinking about dinner.",
    },
    onDismiss: () => {},
  },
};

export const Success: Story = {
  args: {
    toast: {
      id: "2",
      tone: "success",
      title: "Saved",
      message: "Friday pizza night locked in.",
    },
    onDismiss: () => {},
  },
};

export const Warn: Story = {
  args: {
    toast: {
      id: "3",
      tone: "warn",
      title: "Heads up",
      message: "Tonight conflicts with your 5:30 meeting.",
    },
    onDismiss: () => {},
  },
};

export const Error: Story = {
  args: {
    toast: {
      id: "4",
      tone: "error",
      title: "Couldn't reach Spence",
      message: "Network error. Try again?",
    },
    onDismiss: () => {},
  },
};

function PlaygroundInner() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => toast.info("Heads up.")}>info</Button>
      <Button variant="outline" onClick={() => toast.success("Saved.")}>success</Button>
      <Button variant="outline" onClick={() => toast.warn("Be careful.")}>warn</Button>
      <Button variant="outline" onClick={() => toast.error("Something burned.")}>error</Button>
    </div>
  );
}

export const Playground: Story = {
  render: () => (
    <ToastProvider>
      <PlaygroundInner />
    </ToastProvider>
  ),
};
