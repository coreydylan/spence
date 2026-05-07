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

interface Tradition {
  name: string;
  cadence: string;
  description?: string;
  must_include?: string[];
}

interface TraditionsEditSectionProps {
  traditions: Tradition[];
}

const CADENCE_PRESETS = ["weekly", "monthly", "seasonal", "annual"];

/**
 * TraditionsEditSection — list current traditions, add/remove via Sheet.
 *
 * Edits go through `household_set_traditions` (bulk-write semantics — it
 * replaces the full list). We send the merged list so adding one new
 * tradition doesn't drop the existing ones.
 */
export function TraditionsEditSection({ traditions: initial }: TraditionsEditSectionProps) {
  const [traditions, setTraditions] = React.useState<Tradition[]>(initial);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState("");
  const [cadence, setCadence] = React.useState("weekly");
  const [description, setDescription] = React.useState("");
  const toast = useToast();

  const persist = async (next: Tradition[]) => {
    setBusy(true);
    try {
      await mcpClient("household_set_traditions", {
        traditions: next.map((t) => ({
          name: t.name,
          cadence: t.cadence,
          description: t.description,
        })),
      });
      setTraditions(next);
      confirmHaptic();
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name.trim()) return;
    const next = [...traditions, { name: name.trim(), cadence, description: description.trim() || undefined }];
    await persist(next);
    setName("");
    setDescription("");
    setOpen(false);
  };

  const remove = async (idx: number) => {
    tapHaptic();
    await persist(traditions.filter((_, i) => i !== idx));
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Traditions</CardTitle>
          <CardSubtitle>Friday pizza? Sunday roast? Spence remembers.</CardSubtitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {traditions.length === 0 && (
            <p className="text-sm text-ink-soft dark:text-cream/60 italic">
              No traditions recorded yet.
            </p>
          )}
          {traditions.map((t, i) => (
            <div
              key={`${t.name}-${i}`}
              className="flex items-center justify-between gap-3 py-2 border-b border-ink/5 last:border-b-0"
            >
              <div className="flex-1 min-w-0">
                <div className="text-ink dark:text-cream font-medium leading-tight">{t.name}</div>
                <div className="text-xs text-ink-soft dark:text-cream/60 flex gap-2">
                  <span className="capitalize">{t.cadence}</span>
                  {t.description && <span className="truncate">· {t.description}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-ink-soft hover:text-amber transition-colors text-sm shrink-0"
                aria-label={`Remove ${t.name}`}
              >
                Remove
              </button>
            </div>
          ))}
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
            Add tradition
          </Button>
        </div>
      </Card>

      <Sheet open={open} onClose={() => setOpen(false)} side="bottom">
        <div className="p-6 flex flex-col gap-4 max-w-lg mx-auto w-full">
          <h2 className="font-serif text-2xl text-ink">Add a tradition</h2>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-soft">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Friday pizza night"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-ink-soft">Cadence</span>
            <div className="flex flex-wrap gap-2">
              {CADENCE_PRESETS.map((c) => (
                <Chip
                  key={c}
                  variant={cadence === c ? "selected" : "default"}
                  onClick={() => setCadence(c)}
                >
                  {c}
                </Chip>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-ink-soft">Description (optional)</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Wood-fired, every Friday after the kids' soccer practice"
            />
          </label>
          <div className="flex gap-2 mt-2">
            <Button onClick={add} loading={busy} disabled={!name.trim()}>Add</Button>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
