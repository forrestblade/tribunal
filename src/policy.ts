// The rules of the game: who can vote, how many votes each punishment needs,
// and how strikes build up and fade. Everything here can be overridden from
// config.json; these are the defaults the server agreed to start with.

export type Share = "majority" | "two-thirds" | "three-quarters";

export type Punishment =
  | { type: "cooloff"; minutes: number }
  | { type: "warn" }
  | { type: "timeout"; minutes: number }
  | { type: "kick" }
  | { type: "ban"; days: number | null };

export type Track = "member" | "newcomer";

export interface Step {
  /** Stable id used in commands, the database and the mention syntax. */
  id: string;
  label: string;
  /**
   * Ladder level. On the member track a case may ask for at most one level
   * above the target's current level. Passing it records a strike at this
   * level. null means outside the ladder (cool-off): always allowed, no strike.
   */
  level: number | null;
  punishment: Punishment;
  /** Yes votes needed. The proposer cannot vote, so these are other people. */
  yes: number;
  share: Share;
  windowMinutes: number;
  /** Yes votes that must come from voice witnesses when the case is about voice. */
  witnessYes: number;
  /** Pass the moment the threshold is met instead of waiting for the outcome to be certain. */
  closeOnThreshold: boolean;
  /** After a failed vote, how long before the same step can be proposed against the same person. */
  retryAfterFailMinutes: number;
}

export interface VoteRule {
  yes: number;
  share: Share;
  windowMinutes: number;
}

export interface Policy {
  /** Days since first joining before someone counts as a member (can propose and vote). */
  memberMinDays: number;
  /** Strikes count while the punishment is running and for this many days after it ends. */
  strikeWindowDays: number;
  /** The level drops one step for every this-many days without a new strike. */
  decayDays: number;
  /** Filing against someone, or being filed against, keeps you off their votes for this long. */
  involvementDays: number;
  /** After A files against B, B cannot file against A for this long. */
  retaliationLockHours: number;
  /** Witnesses are people who shared a voice channel with the target this long before the case. */
  witnessWindowMinutes: number;
  /** How long to keep the who-was-in-voice log. */
  voiceRetentionDays: number;
  breaker: { maxCasesPerHour: number; pauseMinutes: number };
  memberSteps: Step[];
  newcomerSteps: Step[];
  noContact: VoteRule & { days: number; retryAfterFailMinutes: number };
  appeal: VoteRule & {
    /** A temporary ban can be appealed once this fraction of it has passed. */
    afterFractionOfBan: number;
    /** A permanent ban can be appealed after this many days. */
    permanentAfterDays: number;
    retryAfterFailDays: number;
  };
}

const HOUR = 60;
const DAY = 24 * HOUR;

export const DEFAULT_POLICY: Policy = {
  memberMinDays: 14,
  strikeWindowDays: 90,
  decayDays: 30,
  involvementDays: 7,
  retaliationLockHours: 24,
  witnessWindowMinutes: 30,
  voiceRetentionDays: 7,
  breaker: { maxCasesPerHour: 5, pauseMinutes: 60 },
  memberSteps: [
    {
      id: "cooloff",
      label: "Cool-off 10 min",
      level: null,
      punishment: { type: "cooloff", minutes: 10 },
      yes: 3,
      share: "majority",
      windowMinutes: 3,
      witnessYes: 2,
      closeOnThreshold: true,
      retryAfterFailMinutes: 30,
    },
    {
      id: "warn",
      label: "Warning",
      level: 1,
      punishment: { type: "warn" },
      yes: 3,
      share: "majority",
      windowMinutes: 30,
      witnessYes: 2,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
    {
      id: "timeout-1h",
      label: "Timeout 1h",
      level: 2,
      punishment: { type: "timeout", minutes: HOUR },
      yes: 4,
      share: "two-thirds",
      windowMinutes: 15,
      witnessYes: 2,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
    {
      id: "timeout-24h",
      label: "Timeout 24h",
      level: 3,
      punishment: { type: "timeout", minutes: DAY },
      yes: 5,
      share: "two-thirds",
      windowMinutes: 2 * HOUR,
      witnessYes: 2,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
    {
      id: "timeout-7d",
      label: "Timeout 7 days",
      level: 4,
      punishment: { type: "timeout", minutes: 7 * DAY },
      yes: 6,
      share: "two-thirds",
      windowMinutes: DAY,
      witnessYes: 3,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
    {
      id: "ban-30d",
      label: "Ban 30 days",
      level: 5,
      punishment: { type: "ban", days: 30 },
      yes: 8,
      share: "three-quarters",
      windowMinutes: 2 * DAY,
      witnessYes: 3,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
    {
      id: "ban",
      label: "Permanent ban",
      level: 6,
      punishment: { type: "ban", days: null },
      yes: 10,
      share: "three-quarters",
      windowMinutes: 3 * DAY,
      witnessYes: 3,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
  ],
  newcomerSteps: [
    {
      id: "cooloff",
      label: "Cool-off 10 min",
      level: null,
      punishment: { type: "cooloff", minutes: 10 },
      yes: 2,
      share: "majority",
      windowMinutes: 3,
      witnessYes: 2,
      closeOnThreshold: true,
      retryAfterFailMinutes: 30,
    },
    {
      id: "kick",
      label: "Kick",
      level: 2,
      punishment: { type: "kick" },
      yes: 3,
      share: "two-thirds",
      windowMinutes: 15,
      witnessYes: 2,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
    {
      id: "ban",
      label: "Permanent ban",
      level: 6,
      punishment: { type: "ban", days: null },
      yes: 4,
      share: "two-thirds",
      windowMinutes: HOUR,
      witnessYes: 3,
      closeOnThreshold: false,
      retryAfterFailMinutes: DAY,
    },
  ],
  noContact: { days: 7, yes: 4, share: "two-thirds", windowMinutes: 2 * HOUR, retryAfterFailMinutes: DAY },
  appeal: {
    afterFractionOfBan: 0.5,
    permanentAfterDays: 30,
    retryAfterFailDays: 30,
    yes: 5,
    share: "majority",
    windowMinutes: DAY,
  },
};

export const SHARE_TEXT: Record<Share, string> = {
  majority: "more yes than no",
  "two-thirds": "at least 2/3 yes",
  "three-quarters": "at least 3/4 yes",
};

/** Whether `yes` out of `yes + no` meets the share. Integer math, no rounding surprises. */
export function shareMet(share: Share, yes: number, no: number): boolean {
  const total = yes + no;
  if (total === 0) return false;
  switch (share) {
    case "majority":
      return yes * 2 > total;
    case "two-thirds":
      return yes * 3 >= total * 2;
    case "three-quarters":
      return yes * 4 >= total * 3;
  }
}

export function stepsFor(policy: Policy, track: Track): Step[] {
  return track === "member" ? policy.memberSteps : policy.newcomerSteps;
}

export function findStep(policy: Policy, track: Track, id: string): Step | undefined {
  return stepsFor(policy, track).find((s) => s.id === id);
}

/** Every step id across both tracks, member track order first. */
export function allStepIds(policy: Policy): string[] {
  const ids: string[] = [];
  for (const s of [...policy.memberSteps, ...policy.newcomerSteps]) if (!ids.includes(s.id)) ids.push(s.id);
  return ids;
}

export function stepLabel(policy: Policy, id: string): string {
  return [...policy.memberSteps, ...policy.newcomerSteps].find((s) => s.id === id)?.label ?? id;
}
