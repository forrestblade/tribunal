import { describe, expect, it } from "vitest";
import { currentLevel, highestAllowedStep, stepAllowed } from "../src/engine/ladder.js";
import { DEFAULT_POLICY as P } from "../src/policy.js";

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 0, 1);

describe("currentLevel", () => {
  it("is 0 with no strikes", () => {
    expect(currentLevel([], t0, P)).toBe(0);
  });
  it("holds while the punishment runs", () => {
    const s = { level: 4, imposedAt: t0, endsAt: t0 + 7 * DAY };
    expect(currentLevel([s], t0 + 6 * DAY, P)).toBe(4);
  });
  it("drops one step per 30 clean days after the punishment ends", () => {
    const s = { level: 4, imposedAt: t0, endsAt: t0 + 7 * DAY };
    expect(currentLevel([s], t0 + 7 * DAY + 29 * DAY, P)).toBe(4);
    expect(currentLevel([s], t0 + 7 * DAY + 30 * DAY, P)).toBe(3);
    expect(currentLevel([s], t0 + 7 * DAY + 60 * DAY, P)).toBe(2);
  });
  it("forgets strikes 90 days after they end", () => {
    const s = { level: 4, imposedAt: t0, endsAt: t0 };
    expect(currentLevel([s], t0 + 90 * DAY, P)).toBe(1);
    expect(currentLevel([s], t0 + 91 * DAY, P)).toBe(0);
  });
  it("uses the highest strike and the most recent end", () => {
    const old = { level: 3, imposedAt: t0, endsAt: t0 + DAY };
    const recent = { level: 1, imposedAt: t0 + 40 * DAY, endsAt: t0 + 40 * DAY };
    expect(currentLevel([old, recent], t0 + 41 * DAY, P)).toBe(3);
  });
  it("does not decay during a 30 day ban, so a returning member can face the next step", () => {
    const ban = { level: 5, imposedAt: t0, endsAt: t0 + 30 * DAY };
    expect(currentLevel([ban], t0 + 30 * DAY, P)).toBe(5);
  });
  it("treats a permanent ban as ongoing", () => {
    expect(currentLevel([{ level: 6, imposedAt: t0, endsAt: null }], t0 + 400 * DAY, P)).toBe(6);
  });
});

describe("stepAllowed", () => {
  const step = (id: string) => P.memberSteps.find((s) => s.id === id)!;
  it("allows cool-offs and warnings for anyone", () => {
    expect(stepAllowed(step("cooloff"), 0)).toBe(true);
    expect(stepAllowed(step("warn"), 0)).toBe(true);
  });
  it("allows at most one level above the current one", () => {
    expect(stepAllowed(step("timeout-1h"), 0)).toBe(false);
    expect(stepAllowed(step("timeout-1h"), 1)).toBe(true);
    expect(stepAllowed(step("ban-30d"), 3)).toBe(false);
    expect(stepAllowed(step("ban-30d"), 4)).toBe(true);
  });
  it("reports the highest step on offer", () => {
    expect(highestAllowedStep(P, 0)?.id).toBe("warn");
    expect(highestAllowedStep(P, 4)?.id).toBe("ban-30d");
    expect(highestAllowedStep(P, 9)?.id).toBe("ban");
  });
});
