"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ProgressDots } from "@/components/onboarding/progress-dots";
import { StepShell } from "@/components/onboarding/step-shell";
import {
  STEPS,
  visibleSteps,
  tierProgressFor,
  stepFromQuestionKind,
  findStepIndex,
  type StepDef,
  type StepId,
  type OnboardingState,
} from "@/lib/onboarding-flow";
import { mcpClient, type ChefStatus, type ChefQuestion } from "@/lib/mcp";

import { HouseholdNameStep } from "./steps/household-name";
import { PrimaryMemberStep } from "./steps/primary-member";
import { LocationStep } from "./steps/location";
import { SizeStep } from "./steps/size";
import { FirstHelpStep } from "./steps/first-help";
import { MembersRosterStep } from "./steps/members-roster";
import { AvoidancesStep } from "./steps/avoidances";
import { DinnerRitualStep } from "./steps/dinner-ritual";
import { CookFrequencyStep } from "./steps/cook-frequency";
import { PantryIntakeStep } from "./steps/pantry-intake";
import { PantryPasteStep } from "./steps/pantry-paste";
import { EquipmentGridStep } from "./steps/equipment-grid";
import { TraditionsStep } from "./steps/traditions";
import { FinalStep } from "./steps/final";

/** Local-storage key for resume state — survives reloads on the same device. */
const STORAGE_KEY = "spence.onboarding.state.v1";

interface PersistedState {
  answers: Partial<Record<StepId, unknown>>;
  /** The last step the wizard was on. */
  cursor?: StepId;
}

function loadPersisted(): PersistedState {
  if (typeof window === "undefined") return { answers: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { answers: {} };
    return JSON.parse(raw) as PersistedState;
  } catch {
    return { answers: {} };
  }
}

function persist(state: PersistedState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota
  }
}

export default function OnboardingPage() {
  const router = useRouter();

  const [state, setState] = React.useState<OnboardingState>(() => ({
    answers: loadPersisted().answers,
  }));
  const [cursor, setCursor] = React.useState<StepId>("household_name");
  const [resuming, setResuming] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [serverQuestionId, setServerQuestionId] = React.useState<
    string | undefined
  >(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [cta, setCta] = React.useState<React.ReactNode>(null);

  // Resume logic — fire chef_status_check once on mount.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const persisted = loadPersisted();
      try {
        const status = (await mcpClient(
          "chef_status_check",
          {},
        )) as ChefStatus;
        if (cancelled) return;

        // If onboarding is fully done → bounce to /chat.
        if (status.onboarding.tier_0_done && status.onboarding.tier_1_done) {
          router.replace("/chat");
          return;
        }

        const next: ChefQuestion | null =
          status.recommendation?.next_question ??
          status.onboarding.next_question ??
          null;

        const startId =
          stepFromQuestionKind(next?.kind) ??
          persisted.cursor ??
          "household_name";

        setCursor(startId);
        setServerQuestionId(next?.id);
      } catch {
        // If status check fails (worker unreachable, fresh household), fall
        // back to persisted cursor or the first step.
        setCursor(persisted.cursor ?? "household_name");
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Persist on cursor / answers change.
  React.useEffect(() => {
    persist({ answers: state.answers, cursor });
  }, [state, cursor]);

  const visible = React.useMemo(() => visibleSteps(state), [state]);
  const cursorIndex = findStepIndex(visible, cursor);
  const currentStep: StepDef | undefined = visible[cursorIndex];

  const groups = tierProgressFor(cursor, state);

  const advance = (delta = 1) => {
    const nextIdx = cursorIndex + delta;
    if (nextIdx < 0 || nextIdx >= visible.length) return;
    setCursor(visible[nextIdx].id);
  };

  const back = () => {
    if (cursorIndex <= 0) return;
    advance(-1);
  };

  const handleAnswer = async (
    step: StepDef,
    answer: unknown,
    opts: { skip?: boolean } = {},
  ) => {
    setError(null);
    // Always update local state so going back-and-forward shows the user's
    // previous answer.
    setState((s) => ({
      answers: { ...s.answers, [step.id]: answer },
    }));

    setBusy(true);
    try {
      if (step.tool === "household_onboarding_answer" && step.questionKind) {
        // Worker tool expects question_kind + response_text. (The original
        // typed entry had question_id/answer which silently mismatched.)
        const value = opts.skip ? null : answer;
        const responseText =
          value === null
            ? ""
            : typeof value === "string"
              ? value
              : JSON.stringify(value);
        if (opts.skip) {
          await mcpClient("household_onboarding_skip", {
            question_kind: serverQuestionId ?? step.questionKind,
          });
        } else {
          await mcpClient("household_onboarding_answer", {
            question_kind: serverQuestionId ?? step.questionKind,
            response_text: responseText,
          });
        }
      } else if (step.tool === "household_set_pantry_bulk") {
        await mcpClient("household_set_pantry_bulk", {
          text: typeof answer === "string" ? answer : "",
        });
      } else if (step.tool === "household_set_equipment_bulk") {
        await mcpClient("household_set_equipment_bulk", {
          equipment_slugs: Array.isArray(answer) ? (answer as string[]) : [],
        });
      } else if (step.tool === "household_set_traditions") {
        await mcpClient("household_set_traditions", {
          traditions: Array.isArray(answer)
            ? (answer as { name: string; cadence: string }[])
            : [],
        });
      }

      // After a successful onboarding_answer, refresh the next-question id so
      // the next tier-0/1 step uses the worker's id.
      if (step.tool === "household_onboarding_answer") {
        try {
          const status = (await mcpClient(
            "chef_status_check",
            {},
          )) as ChefStatus;
          const nextQ =
            status.recommendation?.next_question ??
            status.onboarding.next_question ??
            null;
          setServerQuestionId(nextQ?.id);
        } catch {
          // non-fatal
        }
      }

      advance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = (step: StepDef) => {
    if (!step.skippable) return;
    void handleAnswer(step, null, { skip: true });
  };

  const handleFinalize = () => {
    persist({ answers: {}, cursor: "household_name" });
    router.push("/chat?prompt=draft%20me%20a%20week%20of%20dinners");
  };

  const handleJustChat = () => {
    persist({ answers: {}, cursor: "household_name" });
    router.push("/chat");
  };

  if (resuming) {
    return (
      <div className="flex items-center justify-center min-h-dvh">
        <span className="h-6 w-6 rounded-full border-2 border-terracotta border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!currentStep) {
    return (
      <div className="flex items-center justify-center min-h-dvh">
        <p className="text-ink-soft">Onboarding finished.</p>
      </div>
    );
  }

  const tier = currentStep.tier;
  const showBack = cursorIndex > 0 && currentStep.id !== "final";

  return (
    <>
      <ProgressDots groups={groups} activeTier={tier} />

      {error && (
        <div className="mx-5 mb-2 rounded-[var(--radius-md)] bg-amber/15 border border-amber/30 px-3 py-2 text-sm text-amber">
          {error}
        </div>
      )}

      <StepShell
        animationKey={currentStep.id}
        onBack={showBack ? back : undefined}
        onSkip={
          currentStep.skippable && currentStep.id !== "final"
            ? () => handleSkip(currentStep)
            : undefined
        }
        cta={busy ? <DimmedCta>{cta}</DimmedCta> : cta}
      >
        {renderStep(currentStep, state, {
          onAnswer: (a) => handleAnswer(currentStep, a),
          onSkip: () => handleSkip(currentStep),
          bindCta: setCta,
          onDraftWeek: handleFinalize,
          onJustChat: handleJustChat,
        })}
      </StepShell>
    </>
  );
}

function DimmedCta({ children }: { children: React.ReactNode }) {
  return (
    <div className="opacity-60 pointer-events-none">{children}</div>
  );
}

interface StepHandlers {
  onAnswer: (answer: unknown) => void;
  onSkip: () => void;
  bindCta: (cta: React.ReactNode) => void;
  onDraftWeek: () => void;
  onJustChat: () => void;
}

function renderStep(
  step: StepDef,
  state: OnboardingState,
  h: StepHandlers,
): React.ReactNode {
  const { onAnswer, onSkip, bindCta, onDraftWeek, onJustChat } = h;
  const initial = state.answers[step.id];

  switch (step.id) {
    case "household_name":
      return (
        <HouseholdNameStep
          initialValue={typeof initial === "string" ? initial : ""}
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "primary_member":
      return (
        <PrimaryMemberStep
          initialValue={
            initial && typeof initial === "object"
              ? (initial as { name: string; age_group?: string })
              : undefined
          }
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "location":
      return (
        <LocationStep
          initialValue={typeof initial === "string" ? initial : ""}
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "size":
      return (
        <SizeStep
          initialValue={typeof initial === "string" ? initial : undefined}
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "first_help":
      return (
        <FirstHelpStep
          initialValue={typeof initial === "string" ? initial : undefined}
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "members_roster":
      return (
        <MembersRosterStep
          initialValue={
            Array.isArray(initial)
              ? (initial as { name: string; age_group?: string }[])
              : undefined
          }
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "avoidances":
      return (
        <AvoidancesStep
          initialValue={
            initial && typeof initial === "object"
              ? (initial as { tags: string[]; free_text: string })
              : undefined
          }
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "dinner_ritual":
      return (
        <DinnerRitualStep
          initialValue={typeof initial === "string" ? initial : undefined}
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "cook_frequency":
      return (
        <CookFrequencyStep
          initialValue={typeof initial === "string" ? initial : undefined}
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "pantry_intake":
      return (
        <PantryIntakeStep
          initialValue={typeof initial === "string" ? initial : undefined}
          onSubmit={onAnswer}
          bindCta={bindCta}
        />
      );
    case "pantry_paste":
      return (
        <PantryPasteStep
          initialValue={typeof initial === "string" ? initial : ""}
          onSubmit={onAnswer}
          onSkip={onSkip}
          bindCta={bindCta}
        />
      );
    case "equipment_grid":
      return (
        <EquipmentGridStep
          initialValue={
            Array.isArray(initial) ? (initial as string[]) : undefined
          }
          onSubmit={onAnswer}
          onSkip={onSkip}
          bindCta={bindCta}
        />
      );
    case "traditions":
      return (
        <TraditionsStep
          initialValue={
            Array.isArray(initial)
              ? (initial as { name: string; cadence: string }[])
              : undefined
          }
          onSubmit={onAnswer}
          onSkip={onSkip}
          bindCta={bindCta}
        />
      );
    case "final":
      return (
        <FinalStep
          onDraftWeek={onDraftWeek}
          onJustChat={onJustChat}
          bindCta={bindCta}
        />
      );
  }
}
