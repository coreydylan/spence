"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardSubtitle, CardTitle } from "@/components/primitives/card";
import { Button } from "@/components/primitives/button";
import { Input } from "@/components/primitives/input";
import { Sheet } from "@/components/primitives/sheet";
import { Chip } from "@/components/primitives/chip";
import { mcpClient } from "@/lib/mcp";
import { useToast } from "@/components/system/toast-provider";
import { confirmHaptic, tapHaptic } from "@/lib/haptics";

interface EquipmentEditSectionProps {
  equipment: string[];
}

// Common slugs offered as quick-add chips.
const COMMON_SLUGS = [
  "oven",
  "stove",
  "microwave",
  "toaster",
  "sheet_pan",
  "cast_iron",
  "dutch_oven",
  "wok",
  "instant_pot",
  "slow_cooker",
  "rice_cooker",
  "blender",
  "food_processor",
  "stand_mixer",
  "grill",
  "air_fryer",
];

/**
 * EquipmentEditSection — full equipment list editor.
 *
 * The bulk tool is replace-semantics, so we always send the merged list
 * including the existing entries.
 */
export function EquipmentEditSection({ equipment: initial }: EquipmentEditSectionProps) {
  const [equipment, setEquipment] = React.useState<string[]>(initial);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [custom, setCustom] = React.useState("");
  const toast = useToast();

  const persist = async (next: string[]) => {
    setBusy(true);
    try {
      await mcpClient("household_set_equipment_bulk", {
        equipment_slugs: next,
      });
      setEquipment(next);
      confirmHaptic();
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (slug: string) => {
    tapHaptic();
    const next = equipment.includes(slug)
      ? equipment.filter((s) => s !== slug)
      : [...equipment, slug];
    await persist(next);
  };

  const remove = async (slug: string) => {
    tapHaptic();
    await persist(equipment.filter((s) => s !== slug));
  };

  const addCustom = async () => {
    const slug = custom.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!slug) return;
    if (equipment.includes(slug)) {
      toast.warn("Already in your list");
      return;
    }
    await persist([...equipment, slug]);
    setCustom("");
    setOpen(false);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Equipment</CardTitle>
          <CardSubtitle>What you can actually cook with.</CardSubtitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {equipment.length === 0 ? (
            <p className="text-sm text-ink-soft dark:text-cream/60 italic">
              No equipment recorded yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {equipment.map((slug) => (
                <Chip
                  key={slug}
                  variant="active"
                  onClick={() => remove(slug)}
                  className="font-mono text-xs"
                  aria-label={`Remove ${slug}`}
                >
                  {slug.replace(/_/g, " ")}
                  <span aria-hidden className="opacity-70 ml-1">×</span>
                </Chip>
              ))}
            </div>
          )}
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
            Add equipment
          </Button>
        </div>
      </Card>

      <Sheet open={open} onClose={() => setOpen(false)} side="bottom">
        <div className="p-6 flex flex-col gap-4 max-w-lg mx-auto w-full">
          <h2 className="font-serif text-2xl text-ink">Add equipment</h2>
          <p className="text-sm text-ink-soft">Tap to toggle. Custom slugs accepted below.</p>
          <div className="flex flex-wrap gap-2">
            {COMMON_SLUGS.map((slug) => {
              const has = equipment.includes(slug);
              return (
                <Chip
                  key={slug}
                  variant={has ? "selected" : "default"}
                  onClick={() => toggle(slug)}
                  className="font-mono text-xs"
                >
                  {slug.replace(/_/g, " ")}
                </Chip>
              );
            })}
          </div>
          <div className="border-t border-ink/10 pt-4">
            <label className="flex flex-col gap-2">
              <span className="text-sm text-ink-soft">Custom slug</span>
              <div className="flex gap-2">
                <Input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="sous_vide"
                  className="flex-1"
                />
                <Button onClick={addCustom} loading={busy} disabled={!custom.trim()}>
                  Add
                </Button>
              </div>
            </label>
          </div>
          <div className="flex justify-end mt-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Done
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
