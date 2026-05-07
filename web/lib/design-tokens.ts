/**
 * Design tokens mirrored from globals.css `@theme` block.
 * Use these in TypeScript when you need the raw value (e.g. inline SVG fills,
 * dynamic chart colors). For everything else, prefer Tailwind classes.
 */

export const colors = {
  terracotta: "#E07856",
  terracottaSoft: "#F2A98A",
  cream: "#F8F3EC",
  creamDeep: "#EFE7DA",
  ink: "#2A1E15",
  inkSoft: "#5C4A3D",
  sage: "#3F6E4A",
  sageSoft: "#8AB392",
  amber: "#C8893A",
  amberSoft: "#E8C490",
} as const;

export const fonts = {
  sans: '"Inter", ui-sans-serif, system-ui, sans-serif',
  serif: '"Source Serif 4", ui-serif, Georgia, serif',
  mono: '"Fira Code", ui-monospace, monospace',
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 24,
  full: 9999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Shared CSS class for a card with the soft shadow + rounded radius. */
export const cardSurface =
  "bg-cream rounded-[var(--radius-md)] shadow-[var(--shadow-soft)]";
