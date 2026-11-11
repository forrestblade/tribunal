import type { Policy, Step } from "../policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StrikeLike {
  level: number;
  imposedAt: number;
  /** When the punishment ends. null for a permanent ban. */
  endsAt: number | null;
}

/**
 * A member's current ladder level.
 *
 * Strikes count while their punishment runs and for strikeWindowDays after it
 * ends. The level is the highest counted strike, minus one for every
 * decayDays since the most recent punishment ended. Clean time starts when a
 * punishment ends, not when it was given, so a 30 day ban does not decay
 * while it is being served.
 */
export function currentLevel(strikes: StrikeLike[], now: number, policy: Policy): number {
  const window = policy.strikeWindowDays * DAY_MS;
  const counted = strikes.filter((s) => s.endsAt === null || now - s.endsAt <= window);
  if (counted.length === 0) return 0;
  const top = Math.max(...counted.map((s) => s.level));
  const latestEnd = Math.max(...counted.map((s) => (s.endsAt === null ? now : Math.min(s.endsAt, now))));
  const cleanDays = Math.max(0, now - latestEnd) / DAY_MS;
  return Math.max(0, top - Math.floor(cleanDays / policy.decayDays));
}

/** The highest member-track step a case may ask for given the target's level. */
export function highestAllowedStep(policy: Policy, level: number): Step | undefined {
  const allowed = policy.memberSteps.filter((s) => s.level === null || s.level <= level + 1);
  return allowed.filter((s) => s.level !== null).sort((a, b) => (b.level ?? 0) - (a.level ?? 0))[0];
}

export function stepAllowed(step: Step, level: number): boolean {
  return step.level === null || step.level <= level + 1;
}
