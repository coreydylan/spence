import { describe, it, expect } from "vitest";
import {
  classifyPerishTier,
  classifyWithExpiry,
  getTier,
} from "../lib/perishability";

describe("classifyPerishTier", () => {
  it("flags fresh greens / herbs / fish as Tier 1", () => {
    expect(classifyPerishTier("Asparagus")).toBe(1);
    expect(classifyPerishTier("Thai basil")).toBe(1);
    expect(classifyPerishTier("Fresh cilantro")).toBe(1);
    expect(classifyPerishTier("Salmon fillet")).toBe(1);
    expect(classifyPerishTier("Ground beef")).toBe(1);
  });

  it("flags rice / pasta / oils / canned / dried goods as Tier 3", () => {
    expect(classifyPerishTier("Jasmine rice")).toBe(3);
    expect(classifyPerishTier("Pasta")).toBe(3);
    expect(classifyPerishTier("Olive oil")).toBe(3);
    expect(classifyPerishTier("Canned chickpeas")).toBe(3);
    expect(classifyPerishTier("Calabrian chili paste")).toBe(3);
    expect(classifyPerishTier("Tahini")).toBe(3);
  });

  it("defaults unknown items to Tier 2", () => {
    expect(classifyPerishTier("Feta")).toBe(2);
    expect(classifyPerishTier("Firm tofu")).toBe(2);
    expect(classifyPerishTier("Carrot")).toBe(2);
  });

  it("is case-insensitive and tolerates qualifiers", () => {
    expect(classifyPerishTier("FRESH ASPARAGUS")).toBe(1);
    expect(classifyPerishTier("baby spinach")).toBe(1);
  });
});

describe("classifyWithExpiry", () => {
  const NOW = new Date("2026-05-07T12:00:00Z");

  it("forces Tier 1 when expiry is within 48h", () => {
    expect(classifyWithExpiry("feta", "2026-05-08T12:00:00Z", NOW)).toBe(1);
  });

  it("uses Tier 2 when expiry is mid-range", () => {
    expect(classifyWithExpiry("feta", "2026-05-11T12:00:00Z", NOW)).toBe(2);
  });

  it("falls back to name-based when no expiry given", () => {
    expect(classifyWithExpiry("jasmine rice", null, NOW)).toBe(3);
    expect(classifyWithExpiry("asparagus", undefined, NOW)).toBe(1);
  });
});

describe("getTier", () => {
  it("returns metadata for each tier", () => {
    expect(getTier(1).accent).toBe("amber");
    expect(getTier(2).accent).toBe("terracotta");
    expect(getTier(3).accent).toBe("sage");
  });
});
