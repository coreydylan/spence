import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton, SkeletonCard, SkeletonList } from "@/components/system/skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "System/Skeleton",
  component: Skeleton,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof Skeleton>;

export const Line: Story = {
  args: { variant: "line", width: "50%" },
};

export const Block: Story = {
  args: { variant: "block", width: "200px", height: "120px" },
};

export const Circle: Story = {
  args: { variant: "circle", width: "48px", height: "48px" },
};

export const Card: Story = {
  render: () => (
    <div className="max-w-md">
      <SkeletonCard />
    </div>
  ),
};

export const ListOfCards: Story = {
  render: () => (
    <div className="max-w-md">
      <SkeletonList count={3} />
    </div>
  ),
};

export const TextBlock: Story = {
  render: () => (
    <div className="max-w-md flex flex-col gap-2">
      <Skeleton variant="line" className="w-3/4" />
      <Skeleton variant="line" className="w-full" />
      <Skeleton variant="line" className="w-5/6" />
      <Skeleton variant="line" className="w-2/3" />
    </div>
  ),
};
