import type { Meta, StoryObj } from "@storybook/react";
import { IterationSuggestion } from "@/app/cook/[cook_session_id]/active/iteration-suggestion";

const meta: Meta<typeof IterationSuggestion> = {
  title: "Cook/IterationSuggestion",
  component: IterationSuggestion,
  decorators: [
    (Story) => (
      <div className="cook-bg p-6 min-h-[300px] max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    onAccept: () => {},
    onDismiss: () => {},
  },
};
export default meta;
type Story = StoryObj<typeof IterationSuggestion>;

export const Wait: Story = {
  args: {
    suggestion: {
      task_id: "t_sear_tofu",
      action: "wait",
      detail: "The sear is too pale — give it 2 more minutes.",
      extra_min: 2,
    },
  },
};

export const Redo: Story = {
  args: {
    suggestion: {
      task_id: "t_dredge",
      action: "redo",
      detail: "The cornstarch coating is patchy. Re-dredge before frying.",
    },
  },
};

export const AddIngredient: Story = {
  args: {
    suggestion: {
      task_id: "t_sauce",
      action: "add_ingredient",
      detail: "Sauce reads thin. A splash more cornstarch slurry would help.",
      ingredient_to_add: "1 tsp cornstarch slurry",
    },
  },
};

export const AdjustTemp: Story = {
  args: {
    suggestion: {
      task_id: "t_fry",
      action: "adjust_temp",
      detail: "The oil is smoking — drop the heat.",
      temp_delta_pct: -15,
    },
  },
};

export const ExtendTime: Story = {
  args: {
    suggestion: {
      task_id: "t_braise",
      action: "extend_time",
      detail: "Liquid is still loose. Another 8 minutes will tighten it up.",
      extra_min: 8,
    },
  },
};
