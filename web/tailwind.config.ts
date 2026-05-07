import type { Config } from "tailwindcss";

// Tailwind v4 reads tokens primarily from the `@theme` block in globals.css.
// This file exists for content-globbing + plugin compatibility (Storybook, etc.).
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx,mdx}",
    "./components/**/*.{ts,tsx,mdx}",
    "./stories/**/*.{ts,tsx,mdx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
