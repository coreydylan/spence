import * as React from "react";
import { EquipmentChip } from "@/components/meal/equipment-chip";

interface Props {
  equipment: string[];
}

/**
 * EquipmentRow — flat row of equipment chips for the recipe page.
 *
 * In Phase 5 (brigade), this row will color chips by claim status. For now
 * everything renders idle.
 */
export function EquipmentRow({ equipment }: Props) {
  if (!equipment || equipment.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="equipment-row">
      {equipment.map((slug, i) => (
        <EquipmentChip key={`${slug}-${i}`} slug={slug} />
      ))}
    </div>
  );
}
