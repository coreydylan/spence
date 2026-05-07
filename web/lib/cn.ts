import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditional Tailwind class merger. Standard shadcn-style helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
