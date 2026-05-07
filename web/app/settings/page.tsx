import * as React from "react";
import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import {
  mcp,
  mcp_call_any,
  type HouseholdSignals,
  type ChefStatus,
} from "@/lib/mcp";
import { ProfileSection } from "./sections/profile";
import { TraditionsEditSection } from "./sections/traditions-edit";
import { EquipmentEditSection } from "./sections/equipment-edit";
import { CalendarStubSection } from "./sections/calendar-stub";
import { NotificationsSection } from "./sections/notifications";
import { DebugSection } from "./sections/debug";
import { OnboardingSection } from "./sections/onboarding-section";
import { AboutSection } from "./sections/about-section";

/**
 * Settings — server component. Fans out MCP reads in parallel, then hands
 * data down to per-section components (which are mostly client for edit modes).
 *
 * Every read is wrapped in a soft `safe()` so a single failing tool doesn't
 * blank the page — the relevant section just renders an empty / fallback
 * state.
 */
export const dynamic = "force-dynamic";

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export default async function SettingsPage() {
  const h = await headers();
  const session = await getSessionFromHeaders(h);
  const ctx = {
    household_id: session.household_id,
    caller_kind: "human" as const,
    caller_id: "spence-web-settings",
  };

  // Parallel reads. household_read_profile may not exist on the worker yet —
  // safe() returns null and the section renders a fallback.
  const [profile, signals, status, observations] = await Promise.all([
    safe(
      mcp("household_read_profile", { household_id: session.household_id }, ctx),
    ),
    safe(
      mcp(
        "inspire_read_household_signals",
        { household_id: session.household_id },
        ctx,
      ),
    ) as Promise<HouseholdSignals | null>,
    safe(
      mcp("chef_status_check", { household_id: session.household_id }, ctx),
    ) as Promise<ChefStatus | null>,
    safe(
      mcp_call_any(
        "household_read_observations",
        { household_id: session.household_id, limit: 20 },
        ctx,
      ),
    ),
  ]);

  return (
    <>
      <ProfileSection
        userEmail={session.user_email}
        profile={profile}
      />
      <TraditionsEditSection traditions={signals?.traditions ?? []} />
      <EquipmentEditSection equipment={signals?.equipment_available ?? []} />
      <CalendarStubSection />
      <NotificationsSection />
      <OnboardingSection status={status} signals={signals} />
      <DebugSection
        signals={signals}
        status={status}
        observations={observations as unknown as { observations: unknown[] } | null}
      />
      <AboutSection />
    </>
  );
}
