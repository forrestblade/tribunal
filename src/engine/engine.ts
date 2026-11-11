import { plural, when } from "../format.js";
import { findStep, stepsFor, type Policy, type Step, type Track } from "../policy.js";
import type { Store } from "../store.js";
import {
  laneOf,
  type CaseRecord,
  type Evidence,
  type Lane,
  type NewCase,
  type VoteRecord,
  type VoteValue,
} from "../types.js";
import { currentLevel, highestAllowedStep, stepAllowed } from "./ladder.js";
import { decide, type Count, type Decision, type Requirement } from "./tally.js";
import { witnessesOf } from "./witness.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const BREAKER_KEY = "breakerPausedUntil";

/** What the engine needs to know about a server member. The Discord adapter builds these. */
export interface MemberInfo {
  id: string;
  name: string;
  isBot: boolean;
  /** Owner, administrators, and anyone whose top role is above the bot's: Discord will not let the bot act on them. */
  immune: boolean;
  /** When they joined this time, from Discord. The store remembers the earliest sighting. */
  joinedAt: number | null;
  timedOutUntil: number | null;
  voiceChannelId: string | null;
}

/** Something the Discord adapter must do because a case passed. */
export type Effect =
  | { type: "cooloff"; userId: string; minutes: number }
  | { type: "warn"; userId: string }
  | { type: "timeout"; userId: string; minutes: number }
  | { type: "kick"; userId: string }
  | { type: "ban"; userId: string; days: number | null }
  | { type: "unban"; userId: string }
  | { type: "noContact"; aId: string; bId: string; until: number };

export interface Settled {
  case: CaseRecord;
  passed: boolean;
  effects: Effect[];
}

export type Refusal = { ok: false; reason: string; breakerTripped?: boolean };
export type Result<T> = { ok: true; value: T } | Refusal;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = (reason: string): Refusal => ({ ok: false, reason });

export interface SanctionInput {
  proposer: MemberInfo;
  target: MemberInfo;
  stepId: string;
  rule: string | null;
  reason: string;
  /** "auto" means: a voice case if the target is in a voice channel right now. */
  voice: boolean | "auto";
  evidence: Evidence | null;
  members: MemberInfo[];
}

export interface NoContactInput {
  proposer: MemberInfo;
  a: MemberInfo;
  b: MemberInfo;
  reason: string;
  members: MemberInfo[];
}

export interface AppealInput {
  proposer: MemberInfo;
  userId: string;
  reason: string;
  members: MemberInfo[];
}

export interface VoteOutcome {
  case: CaseRecord;
  previous: VoteValue | null;
  /** Set when this vote decided the case. */
  settled: Settled | null;
}

export interface Tally extends Count {
  votes: VoteRecord[];
  decision: Decision;
}

export interface MemberRecord {
  level: number;
  strikes: { caseId: number; stepId: string | null; level: number; endsAt: number | null }[];
  ban: { caseId: number; until: number | null } | null;
  /** Ladder steps a case against this person could ask for right now. */
  canBeProposed: Step[];
}

/** The fields every kind of case shares once the guards have passed. */
interface Draft {
  kind: CaseRecord["kind"];
  proposerId: string;
  accused: string[];
  reason: string;
  requirement: Requirement;
  windowMinutes: number;
  witnesses?: string[];
  extra?: Partial<NewCase>;
}

/**
 * The rules. Synchronous on purpose: each public method does its checks and
 * writes inside one SQLite transaction, so two clicks arriving together cannot
 * both close a case or both file one. It never touches Discord; it returns
 * effects for the adapter to apply.
 */
export class Engine {
  constructor(
    readonly store: Store,
    readonly policy: Policy,
    readonly shadow: boolean,
    readonly now: () => number = Date.now,
  ) {}

  // People ------------------------------------------------------------------

  /** Days since we first saw them in the server. Rejoining does not reset this. */
  memberAgeDays(m: MemberInfo): number {
    const sightings = [this.store.firstSeen(m.id), m.joinedAt].filter((v): v is number => v !== null);
    if (sightings.length === 0) return 0;
    return (this.now() - Math.min(...sightings)) / DAY;
  }

  isMember(m: MemberInfo): boolean {
    return !m.isBot && this.memberAgeDays(m) >= this.policy.memberMinDays;
  }

  trackOf(m: MemberInfo): Track {
    return this.isMember(m) ? "member" : "newcomer";
  }

  level(userId: string): number {
    return currentLevel(this.store.strikes(userId, this.shadow), this.now(), this.policy);
  }

  /** Steps a case against this person may ask for right now, for menus. */
  allowedSteps(target: MemberInfo): Step[] {
    if (this.trackOf(target) === "newcomer") return this.policy.newcomerSteps;
    const level = this.level(target.id);
    return this.policy.memberSteps.filter((s) => stepAllowed(s, level));
  }

  record(userId: string, info: MemberInfo | null): MemberRecord {
    const ban = this.store.activeBan(userId, this.shadow);
    return {
      level: this.level(userId),
      strikes: this.store.strikes(userId, this.shadow).map((s) => ({
        caseId: s.caseId,
        stepId: this.store.getCase(s.caseId)?.stepId ?? null,
        level: s.level,
        endsAt: s.endsAt,
      })),
      ban: ban ? { caseId: ban.caseId, until: ban.until } : null,
      canBeProposed: info ? this.allowedSteps(info).filter((s) => s.level !== null) : [],
    };
  }

  /** Banned users an appeal could be filed for, newest first. */
  appealable(): { userId: string; caseId: number; until: number | null }[] {
    return this.store.activeBans(this.shadow).map((b) => ({ userId: b.userId, caseId: b.caseId, until: b.until }));
  }

  private isTimedOut(m: MemberInfo): boolean {
    return m.timedOutUntil !== null && m.timedOutUntil > this.now();
  }

  private accusedOf(c: CaseRecord): string[] {
    if (c.kind === "appeal") return [];
    return c.partyBId ? [c.targetId, c.partyBId] : [c.targetId];
  }

  /** Whether two people were on opposite sides of a case recently, or both parties to a no-contact case. */
  private involved(voterId: string, accusedId: string, recent: CaseRecord[]): boolean {
    return recent.some((c) => {
      const accused = this.accusedOf(c);
      if (c.proposerId === voterId && accused.includes(accusedId)) return true;
      if (c.proposerId === accusedId && accused.includes(voterId)) return true;
      return c.kind === "nocontact" && accused.includes(voterId) && accused.includes(accusedId);
    });
  }

  /** Everyone who may vote on a case about `accused`, frozen at filing time. */
  private electorate(members: MemberInfo[], proposerId: string, accused: string[]): string[] {
    const recent = this.store.casesSince(this.now() - this.policy.involvementDays * DAY);
    const excluded = new Set([proposerId, ...accused]);
    return members
      .filter((m) => this.isMember(m) && !this.isTimedOut(m) && !excluded.has(m.id))
      .filter((m) => !accused.some((a) => this.involved(m.id, a, recent)))
      .map((m) => m.id);
  }

  // Filing guards -----------------------------------------------------------

  private checkFilingOpen(proposer: MemberInfo): string | null {
    const pausedUntil = this.breakerPausedUntil();
    if (pausedUntil) {
      return `Too many cases were filed in the last hour, so new cases are paused until ${when(pausedUntil, "t")}.`;
    }
    if (proposer.isBot) return "Bots can't file cases.";
    if (!this.isMember(proposer)) {
      return `You can file cases once you've been in the server ${this.policy.memberMinDays} days.`;
    }
    if (this.isTimedOut(proposer)) return "You can't file cases while you're timed out.";
    return null;
  }

  private checkActionable(m: MemberInfo, what: string): string | null {
    if (m.isBot) return `Bots can't ${what}.`;
    if (m.immune) return `${m.name} is the owner, an admin, or ranks above the bot, so the bot can't act on them.`;
    return null;
  }

  private checkLaneFree(lane: Lane, accused: string[], proposerId: string): string | null {
    const open = this.store.openCases().filter((c) => laneOf(c) === lane);
    const aboutThem = open.find((c) => this.accusedOf(c).some((id) => accused.includes(id)));
    if (aboutThem) return `There's already an open case about them (case #${aboutThem.id}). Vote on that one.`;
    const mine = open.find((c) => c.proposerId === proposerId);
    if (mine) return `You already have an open case (case #${mine.id}). Wait for it to close.`;
    return null;
  }

  private checkNotRetaliation(proposer: MemberInfo, target: MemberInfo): string | null {
    const lockMs = this.policy.retaliationLockHours * HOUR;
    const theirs = this.store
      .casesSince(this.now() - lockMs)
      .find((c) => c.proposerId === target.id && this.accusedOf(c).includes(proposer.id));
    if (!theirs) return null;
    return `${target.name} filed case #${theirs.id} against you, so you can't file against them until ${when(theirs.filedAt + lockMs)}. You can post a statement on that case instead.`;
  }

  /** Refuse if the same thing was voted down recently. */
  private checkNotRetried(matches: (c: CaseRecord) => boolean, retryAfterMs: number, what: string): string | null {
    const failed = this.store
      .casesClosedAfter(this.now() - retryAfterMs)
      .find((c) => c.status === "failed" && matches(c));
    if (!failed) return null;
    return `${what} failed (case #${failed.id}). It can't be proposed again until ${when(failed.closedAt! + retryAfterMs)}.`;
  }

  private checkCanPass(electorate: string[], witnesses: string[], req: Requirement): string | null {
    if (electorate.length < req.yes) {
      return `Only ${plural(electorate.length, "person", "people")} can vote on this and it needs ${req.yes} yes, so it couldn't pass.`;
    }
    const eligibleWitnesses = witnesses.filter((w) => electorate.includes(w)).length;
    if (eligibleWitnesses < req.witnessYes) {
      return `Voice cases need ${req.witnessYes} yes votes from people who were in voice with them, and only ${eligibleWitnesses} of those can vote.`;
    }
    return null;
  }

  /** Build the electorate, check the case could pass, trip the breaker if needed, and save. */
  private open(draft: Draft, members: MemberInfo[]): Result<CaseRecord> {
    const electorate = this.electorate(members, draft.proposerId, draft.accused);
    const witnesses = draft.witnesses ?? [];
    const cannotPass = this.checkCanPass(electorate, witnesses, draft.requirement);
    if (cannotPass) return refuse(cannotPass);
    if (this.tripBreaker()) {
      const { maxCasesPerHour, pauseMinutes } = this.policy.breaker;
      return {
        ok: false,
        breakerTripped: true,
        reason: `${maxCasesPerHour} cases were already filed in the last hour, so new cases are paused for ${pauseMinutes} minutes.`,
      };
    }
    const now = this.now();
    return ok(
      this.store.insertCase({
        kind: draft.kind,
        track: null,
        stepId: null,
        targetId: draft.accused[0]!,
        partyBId: draft.accused[1] ?? null,
        proposerId: draft.proposerId,
        rule: null,
        reason: draft.reason,
        voice: false,
        evidence: null,
        electorate,
        witnesses,
        requirement: draft.requirement,
        targetLevel: null,
        filedAt: now,
        closesAt: now + draft.windowMinutes * MIN,
        shadow: this.shadow,
        appealOf: null,
        ...draft.extra,
      }),
    );
  }

  // Filing ------------------------------------------------------------------

  fileSanction(input: SanctionInput): Result<CaseRecord> {
    return this.store.tx(() => {
      const { proposer, target } = input;
      const early =
        this.checkFilingOpen(proposer) ??
        (target.id === proposer.id ? "You can't file a case against yourself." : null) ??
        this.checkActionable(target, "be put on trial");
      if (early) return refuse(early);

      const track = this.trackOf(target);
      const step = findStep(this.policy, track, input.stepId);
      if (!step) {
        const options = stepsFor(this.policy, track)
          .map((s) => s.label)
          .join(", ");
        return refuse(
          `${target.name} is ${track === "member" ? "a member" : "a newcomer"}, so the options are: ${options}.`,
        );
      }
      const level = this.level(target.id);
      if (track === "member" && !stepAllowed(step, level)) {
        const top = highestAllowedStep(this.policy, level);
        return refuse(
          `${target.name} is at level ${level}, so the most a case can ask for is ${top?.label ?? "a warning"}. Punishments go up one step at a time.`,
        );
      }

      const later =
        this.checkLaneFree(laneOf({ kind: "sanction", stepId: step.id }), [target.id], proposer.id) ??
        this.checkNotRetaliation(proposer, target) ??
        this.checkNotRetried(
          (c) => c.kind === "sanction" && c.targetId === target.id && c.stepId === step.id,
          step.retryAfterFailMinutes * MIN,
          `A vote for ${step.label} on ${target.name}`,
        );
      if (later) return refuse(later);

      const voice = input.voice === "auto" ? target.voiceChannelId !== null : input.voice;
      const witnesses = voice ? this.witnesses(target.id) : [];
      if (voice && !witnesses.includes(proposer.id)) {
        return refuse(
          `For a voice case you need to have been in voice with ${target.name} in the last ${this.policy.witnessWindowMinutes} minutes.`,
        );
      }

      return this.open(
        {
          kind: "sanction",
          proposerId: proposer.id,
          accused: [target.id],
          reason: input.reason,
          requirement: {
            yes: step.yes,
            share: step.share,
            witnessYes: voice ? Math.min(step.witnessYes, step.yes) : 0,
            closeOnThreshold: step.closeOnThreshold,
          },
          windowMinutes: step.windowMinutes,
          witnesses,
          extra: {
            track,
            stepId: step.id,
            rule: input.rule,
            voice,
            evidence: input.evidence,
            targetLevel: track === "member" ? level : null,
          },
        },
        input.members,
      );
    });
  }

  fileNoContact(input: NoContactInput): Result<CaseRecord> {
    return this.store.tx(() => {
      const { proposer, a, b } = input;
      const rule = this.policy.noContact;
      const samePair = (c: { targetId: string; partyBId: string | null }) =>
        (c.targetId === a.id && c.partyBId === b.id) || (c.targetId === b.id && c.partyBId === a.id);
      const active = this.store
        .activeNoContacts(this.now(), this.shadow)
        .some((o) => samePair({ targetId: o.aId, partyBId: o.bId }));

      const problem =
        this.checkFilingOpen(proposer) ??
        (a.id === b.id ? "A no-contact order needs two different people." : null) ??
        (proposer.id === a.id || proposer.id === b.id
          ? "A no-contact order has to be proposed by someone outside the feud."
          : null) ??
        this.checkActionable(a, "be part of a no-contact order") ??
        this.checkActionable(b, "be part of a no-contact order") ??
        (active ? `${a.name} and ${b.name} already have a no-contact order.` : null) ??
        this.checkLaneFree("nocontact", [a.id, b.id], proposer.id) ??
        this.checkNotRetried(
          (c) => c.kind === "nocontact" && samePair(c),
          rule.retryAfterFailMinutes * MIN,
          "A no-contact vote for them",
        );
      if (problem) return refuse(problem);

      return this.open(
        {
          kind: "nocontact",
          proposerId: proposer.id,
          accused: [a.id, b.id],
          reason: input.reason,
          requirement: { yes: rule.yes, share: rule.share, witnessYes: 0, closeOnThreshold: false },
          windowMinutes: rule.windowMinutes,
        },
        input.members,
      );
    });
  }

  fileAppeal(input: AppealInput): Result<CaseRecord> {
    return this.store.tx(() => {
      const { proposer, userId } = input;
      const rule = this.policy.appeal;
      const closed = this.checkFilingOpen(proposer);
      if (closed) return refuse(closed);

      const ban = this.store.activeBan(userId, this.shadow);
      if (!ban) return refuse("That person doesn't have an active ban from the bot.");
      const eligibleAt =
        ban.until === null
          ? ban.imposedAt + rule.permanentAfterDays * DAY
          : ban.imposedAt + (ban.until - ban.imposedAt) * rule.afterFractionOfBan;
      if (this.now() < eligibleAt) return refuse(`This ban can be appealed from ${when(eligibleAt)}.`);

      const problem =
        this.checkLaneFree("appeal", [userId], proposer.id) ??
        this.checkNotRetried(
          (c) => c.kind === "appeal" && c.appealOf === ban.caseId,
          rule.retryAfterFailDays * DAY,
          "An appeal for this ban",
        );
      if (problem) return refuse(problem);

      return this.open(
        {
          kind: "appeal",
          proposerId: proposer.id,
          accused: [userId],
          reason: input.reason,
          requirement: { yes: rule.yes, share: rule.share, witnessYes: 0, closeOnThreshold: false },
          windowMinutes: rule.windowMinutes,
          extra: { appealOf: ban.caseId },
        },
        input.members,
      );
    });
  }

  private witnesses(targetId: string): string[] {
    const from = this.now() - this.policy.witnessWindowMinutes * MIN;
    return [...witnessesOf(targetId, this.store.sessionsSince(from), from, this.now())];
  }

  // The breaker -------------------------------------------------------------

  breakerPausedUntil(): number | null {
    const until = Number(this.store.getState(BREAKER_KEY) ?? 0);
    return until > this.now() ? until : null;
  }

  /** Trip the breaker if one more filing would exceed the hourly limit. */
  private tripBreaker(): boolean {
    if (this.store.countCasesSince(this.now() - HOUR) < this.policy.breaker.maxCasesPerHour) return false;
    this.store.setState(BREAKER_KEY, String(this.now() + this.policy.breaker.pauseMinutes * MIN));
    return true;
  }

  // Voting ------------------------------------------------------------------

  tally(c: CaseRecord): Tally {
    const votes = this.store.votes(c.id).filter((v) => c.electorate.includes(v.voterId));
    const yes = votes.filter((v) => v.value === "yes");
    const voted = new Set(votes.map((v) => v.voterId));
    const count: Count = {
      yes: yes.length,
      no: votes.length - yes.length,
      witnessYes: yes.filter((v) => c.witnesses.includes(v.voterId)).length,
      remaining: c.electorate.length - votes.length,
      witnessRemaining: c.witnesses.filter((w) => c.electorate.includes(w) && !voted.has(w)).length,
    };
    const final = c.status !== "open" || this.now() >= c.closesAt;
    return { ...count, votes, decision: decide(c.requirement, count, final) };
  }

  whyCantVote(c: CaseRecord, voterId: string): string {
    if (voterId === c.targetId || voterId === c.partyBId) return "You can't vote on a case about you.";
    if (voterId === c.proposerId) return "You filed this case, so you don't get a vote on it.";
    return `You're not on this case's voter list. Voters are members who had been in the server ${this.policy.memberMinDays}+ days when it was filed and haven't filed against, or been filed against by, the people in it in the last ${this.policy.involvementDays} days.`;
  }

  vote(caseId: number, voterId: string, value: VoteValue): Result<VoteOutcome> {
    return this.store.tx(() => {
      const c = this.store.getCase(caseId);
      if (!c) return refuse(`There's no case #${caseId}.`);
      if (c.status !== "open") return refuse(`Case #${caseId} is closed.`);
      if (this.now() >= c.closesAt) {
        return refuse(`Voting on case #${caseId} has ended. The result will be posted in a moment.`);
      }
      if (!c.electorate.includes(voterId)) return refuse(this.whyCantVote(c, voterId));
      const previous = this.store.votes(caseId).find((v) => v.voterId === voterId)?.value ?? null;
      this.store.castVote(caseId, voterId, value, this.now());
      const settled = this.settle(caseId);
      return ok({ case: settled?.case ?? this.store.getCase(caseId)!, previous, settled });
    });
  }

  /** Close every case whose deadline has passed. */
  closeDue(): Settled[] {
    const out: Settled[] = [];
    for (const c of this.store.dueCases(this.now())) {
      const s = this.store.tx(() => this.settle(c.id));
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Decide a case. If decided, close it and record the consequences (strikes,
   * bans, orders) in the same transaction. Returns null while it is still open
   * or if something else already closed it.
   */
  private settle(caseId: number): Settled | null {
    const c = this.store.getCase(caseId);
    if (!c || c.status !== "open") return null;
    const { decision } = this.tally(c);
    if (decision === "open") return null;
    const passed = decision === "pass";
    if (!this.store.closeCase(c.id, passed ? "passed" : "failed", this.now())) return null;
    const closed = this.store.getCase(c.id)!;
    return { case: closed, passed, effects: passed ? this.recordOutcome(closed) : [] };
  }

  private recordOutcome(c: CaseRecord): Effect[] {
    const now = this.now();
    switch (c.kind) {
      case "nocontact": {
        const until = now + this.policy.noContact.days * DAY;
        this.store.addNoContact({ caseId: c.id, aId: c.targetId, bId: c.partyBId!, until, shadow: c.shadow });
        return [{ type: "noContact", aId: c.targetId, bId: c.partyBId!, until }];
      }
      case "appeal": {
        this.store.liftBan(c.targetId, now);
        this.store.cancelScheduled("unban", c.targetId, now);
        if (c.appealOf !== null) this.store.voidStrike(c.appealOf);
        return [{ type: "unban", userId: c.targetId }];
      }
      case "sanction":
        return this.recordSanction(c);
    }
  }

  private recordSanction(c: CaseRecord): Effect[] {
    const step = findStep(this.policy, c.track ?? "member", c.stepId ?? "");
    if (!step) return [];
    const now = this.now();
    const p = step.punishment;
    const endsAt =
      p.type === "timeout"
        ? now + p.minutes * MIN
        : p.type === "ban"
          ? p.days === null
            ? null
            : now + p.days * DAY
          : now;
    if (step.level !== null) {
      this.store.addStrike({
        userId: c.targetId,
        caseId: c.id,
        level: step.level,
        imposedAt: now,
        endsAt,
        shadow: c.shadow,
      });
    }
    switch (p.type) {
      case "cooloff":
        return [{ type: "cooloff", userId: c.targetId, minutes: p.minutes }];
      case "warn":
        return [{ type: "warn", userId: c.targetId }];
      case "timeout":
        return [{ type: "timeout", userId: c.targetId, minutes: p.minutes }];
      case "kick":
        return [{ type: "kick", userId: c.targetId }];
      case "ban":
        this.store.addBan({ userId: c.targetId, caseId: c.id, imposedAt: now, until: endsAt, shadow: c.shadow });
        if (endsAt !== null) this.store.schedule("unban", c.targetId, c.id, endsAt);
        return [{ type: "ban", userId: c.targetId, days: p.days }];
    }
  }

  canMakeStatement(c: CaseRecord, userId: string): boolean {
    return c.status === "open" && c.kind !== "appeal" && (userId === c.targetId || userId === c.partyBId);
  }

  // Housekeeping ------------------------------------------------------------

  /** A scheduled unban came due. Returns the case if the ban was still ours to lift. */
  liftDueBan(userId: string, caseId: number): CaseRecord | null {
    return this.store.tx(() => {
      const ban = this.store.activeBan(userId, this.shadow);
      if (!ban || ban.caseId !== caseId) return null;
      this.store.liftBan(userId, this.now());
      return this.store.getCase(caseId);
    });
  }

  /** A ban was lifted outside the bot, for example by hand in Discord. Only live bans are affected. */
  banLiftedElsewhere(userId: string): void {
    this.store.tx(() => {
      const ban = this.store.activeBan(userId, false);
      if (!ban) return;
      this.store.liftBan(userId, this.now());
      this.store.cancelScheduled("unban", userId, this.now());
      this.store.endStrike(ban.caseId, this.now());
    });
  }

  purgeOldVoice(): void {
    this.store.purgeSessions(this.now() - this.policy.voiceRetentionDays * DAY);
  }
}
