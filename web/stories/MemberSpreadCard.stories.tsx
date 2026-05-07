import type { Meta, StoryObj } from "@storybook/react";
import { MemberSpreadCard } from "@/app/members/components/member-spread-card";
import type { TraitSpread } from "@/lib/mcp";

const meta: Meta<typeof MemberSpreadCard> = {
  title: "Members/MemberSpreadCard",
  component: MemberSpreadCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof MemberSpreadCard>;

export const Diverging: Story = {
  args: {
    spreads: [
      {
        trait_name: "comfort_vs_adventure",
        household_value: 0.55,
        household_confidence: 0.6,
        member_values: [
          { member_id: "mem_corey", value: 0.2, confidence: 0.7 },
          { member_id: "mem_katrina", value: 0.85, confidence: 0.7 },
        ],
        divergence: 0.65,
        status: "diverging",
        description:
          "Corey leans comfort, Katrina leans adventure. Try alternating or splitting dishes.",
      },
      {
        trait_name: "spice_tolerance",
        household_value: 0.5,
        household_confidence: 0.5,
        member_values: [
          { member_id: "mem_corey", value: 0.3, confidence: 0.5 },
          { member_id: "mem_katrina", value: 0.8, confidence: 0.5 },
        ],
        divergence: 0.5,
        status: "diverging",
        description:
          "Spice spread is wide — keep the chili on the side or split portions before saucing.",
      },
    ],
  },
};

export const Aligned: Story = {
  args: {
    spreads: [
      {
        trait_name: "comfort_vs_adventure",
        household_value: 0.45,
        household_confidence: 0.6,
        member_values: [
          { member_id: "mem_corey", value: 0.4, confidence: 0.6 },
          { member_id: "mem_katrina", value: 0.5, confidence: 0.6 },
        ],
        divergence: 0.1,
        status: "aligned",
        description: "Both lean comfort with occasional adventure.",
      },
    ],
  },
};
