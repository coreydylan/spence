"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardSubtitle, CardTitle } from "@/components/primitives/card";
import { Button } from "@/components/primitives/button";
import { Input } from "@/components/primitives/input";
import { Sheet } from "@/components/primitives/sheet";
import { Badge } from "@/components/primitives/badge";
import { mcpClient } from "@/lib/mcp";
import { useToast } from "@/components/system/toast-provider";
import { confirmHaptic, tapHaptic } from "@/lib/haptics";

interface Profile {
  household_id: string;
  household_name?: string;
  primary_member_name?: string;
  location?: string;
  timezone?: string;
}

interface ProfileSectionProps {
  userEmail: string;
  profile: Profile | null;
}

const COMMON_TZS = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
];

/**
 * ProfileSection — household name, email (read-only from CF Access),
 * location, timezone. Edit mode uses a Sheet.
 *
 * Track 3 added the timezone column. We list common US/EU timezones plus a
 * free-text option for anything else.
 */
export function ProfileSection({ userEmail, profile }: ProfileSectionProps) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const toast = useToast();

  const [household_name, setHouseholdName] = React.useState(profile?.household_name ?? "");
  const [location, setLocation] = React.useState(profile?.location ?? "");
  const [timezone, setTimezone] = React.useState(
    profile?.timezone ??
      (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : ""),
  );

  const save = async () => {
    setBusy(true);
    try {
      await mcpClient("household_update_profile", {
        household_name: household_name || undefined,
        location: location || undefined,
        timezone: timezone || undefined,
      });
      confirmHaptic();
      toast.success("Profile saved");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Profile</CardTitle>
          <CardSubtitle>Who Spence thinks you are.</CardSubtitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field label="Household">
            <span className="text-ink dark:text-cream">
              {profile?.household_name ?? <em className="text-ink-soft">unnamed</em>}
            </span>
          </Field>
          <Field label="Email">
            <span className="text-ink dark:text-cream font-mono text-sm">{userEmail}</span>
            <Badge tone="neutral" className="ml-2">read-only</Badge>
          </Field>
          <Field label="Location">
            <span className="text-ink dark:text-cream">
              {profile?.location ?? <em className="text-ink-soft">not set</em>}
            </span>
          </Field>
          <Field label="Timezone">
            <span className="font-mono text-sm text-ink dark:text-cream">
              {profile?.timezone ?? <em className="text-ink-soft">not set</em>}
            </span>
          </Field>
        </CardContent>
        <div className="px-5 pb-5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              tapHaptic();
              setOpen(true);
            }}
          >
            Edit profile
          </Button>
        </div>
      </Card>

      <Sheet open={open} onClose={() => setOpen(false)} side="bottom">
        <div className="p-6 flex flex-col gap-4 max-w-lg mx-auto w-full">
          <h2 className="font-serif text-2xl text-ink">Edit profile</h2>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-soft">Household name</span>
            <Input
              value={household_name}
              onChange={(e) => setHouseholdName(e.target.value)}
              placeholder="The Wong house"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-soft">Location (city)</span>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="San Diego, CA"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-soft">Timezone</span>
            <Input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/Los_Angeles"
              list="tz-suggestions"
            />
            <datalist id="tz-suggestions">
              {COMMON_TZS.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </label>
          <div className="flex gap-2 mt-2">
            <Button onClick={save} loading={busy}>Save</Button>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-3 py-1.5 border-b border-ink/5 last:border-b-0">
      <span className="text-sm text-ink-soft dark:text-cream/60">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
