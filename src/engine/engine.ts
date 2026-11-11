import { findStep, stepsFor, type Policy, type Step, type Track } from "../policy.js";
import type { Store } from "../store.js";
import { laneOf, type CaseRecord, type Evidence, type Lane, type NewCase, type VoteRecord, type VoteValue } from "../types.js";
import { currentLevel, highestAllowedStep, stepAllowed } from "./ladder.js";
import { decide, type Count, type Decision, type Requirement } from "./tally.js";
import { witnessesOf } from "./witness.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** What the engine needs to know about a server member. Built from Discord by the adapter. */
export interface MemberInfo {
  id: string;
  name: string;
  isBot: boolean;
  /** Server owner, administrators, and anyone the bot's role cannot act on. */
  immune: boolean;
  /** When they joined the server this time, from Discord. */
  joinedAt: number | null;
  timedOutUntil: number | null;
  voiceChannelId: string | null;
}

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

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string; breakerTripped?: boolean };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (reason: string, breakerTripped = false): Result<never> => ({ ok: false, reason, breakerTripped });

export interface SanctionInput {
  proposer: MemberInfo;
  target: MemberInfo;
  stepId: string;
  rule: string | null;
  reason: string;
  /** "auto": treat as voice if the target is in a voice channel right now. */
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
  settled: Settled | null;
}

export interface Tally extends Count {
  votes: VoteRecord[];
  decision: Decision;
}

const BREAKER_KEY = "breakerPausedUntil";

/**
 * The rules engine. Synchronous on purpose: every check-and-write happens in
 * one SQLite transaction, so two clicks arriving together cannot both close a
 * case or both file one. The Discord side applies the returned effects.
 */
export class Engine {
  constructor(
    readonly store: Store,
    readonly policy: Policy,
    readonly shadow: boolean,
    readonly now: () => number = Date.now,
  ) {}

  // People ----------------------------------------------------------------

  /** Days since we first saw them in the server. Rejoining does not reset this. */
  memberAgeDays(m: MemberInfo): number {
    const seen = this.store.firstSeen(m.id);
    const candidates = [seen, m.joinedAt].filter((v): v is number => v !== null);
    if (candidates.length === 0) return 0;
    return (this.now() - Math.min(...candidates)) / DAY;
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
    const track = this.trackOf(target);
    if (track === "newcomer") return this.policy.newcomerSteps;
    const level = this.level(target.id);
    return this.policy.memberSteps.filter((s) => stepAllowed(s, level));
  }

  private timedOut(m: MemberInfo): boolean {
    return m.timedOutUntil !== null && m.timedOutUntil > this.now();
  }

  private accusedOf(c: CaseRecord): string[] {
    if (c.kind === "appeal") return [];
    return c.partyBId ? [c.targetId, c.partyBId] : [c.targetId];
  }

  /** Whether voter and accused were on opposite sides of a recent case, or both parties to a no-contact case. */
  private involved(voterId: string, accusedId: string, recent: CaseRecord[]): boolean {
    return recent.some((c) => {
      const accused = this.accusedOf(c);
      if (c.proposerId === voterId && accused.includes(accusedId)) return true;
      if (c.proposerId === accusedId && accused.includes(voterId)) return true;
      return c.kind === "nocontact" && accused.includes(voterId) && accused.includes(accusedId);
    });
  }

  private electorate(members: MemberInfo[], exclude: string[], accused: string[]): string[] {
    const recent = this.store.casesSince(this.now() - this.policy.involvementDays * DAY);
    return members
      .filter((m) => this.isMember(m) && !this.timedOut(m) && !exclude.includes(m.id))
      .filter((m) => !accused.some((a) => this.involved(m.id, a, recent)))
      .map((m) => m.id);
  }

  // Shared checks -----------------------------------------------------------

  private checkProposer(p: MemberInfo): string | null {
    if (p.isBot) return "Bots can't file cases.";
    if (!this.isMember(p)) return `You can file cases once you've been in the server ${this.policy.memberMinDays} days.`;
    if (this.timedOut(p)) return "You can't file cases while you're timed out.";
    return null;
  }

  private checkBreaker(): string | null {
    const until = Number(this.store.getState(BREAKER_KEY) ?? 0);
    if (until > this.now()) return `Too many cases were filed in the last hour, so new cases are paused until <t:${Math.ceil(until / 1000)}:t>.`;
    return null;
  }

  /** Trip the breaker if this filing would go over the hourly limit. */
  private tripBreaker(): boolean {
    const lastHour = this.store.casesSince(this.now() - HOUR).length;
    if (lastHour < this.policy.breaker.maxCasesPerHour) return false;
    this.store.setState(BREAKER_KEY, String(this.now() + this.policy.breaker.pauseMinutes * MIN));
    return true;
  }

  breakerPausedUntil(): number | null {
    const until = Number(this.store.getState(BREAKER_KEY) ?? 0);
    return until > this.now() ? until : null;
  }

  private openInLane(lane: Lane): CaseRecord[] {
    return this.store.openCases().filter((c) => laneOf(c) === lane);
  }

  private checkElectorate(electorate: string[], witnesses: string[], req: Requirement): string | null {
    if (electorate.length < req.yes) {
      return `Only ${electorate.length} ${electorate.length === 1 ? "person" : "people"} can vote on this and it needs ${req.yes} yes, so it couldn't pass.`;
    }
    const eligibleWitnesses = witnesses.filter((w) => electorate.includes(w)).length;
    if (eligibleWitnesses < req.witnessYes) {
      return `Voice cases need ${req.witnessYes} yes votes from people who were in voice with them, and only ${eligibleWitnesses} of those can vote.`;
    }
    return null;
  }

  private create(c: NewCase, breakerReason: string): Result<CaseRecord> {
    if (this.tripBreaker()) return no(breakerReason, true);
    return ok(this.store.insertCase(c));
  }

  // Filing ----------------------------------------------------------------

  fileSanction(input: SanctionInput): Result<CaseRecord> {
    return this.store.tx(() => this.fileSanctionTx(input));
  }

  private fileSanctionTx(input: SanctionInput): Result<CaseRecord> {
    const { proposer: p, target: t } = input;
    const now = this.now();
    const paused = this.checkBreaker();
    if (paused) return no(paused);
    const bad = this.checkProposer(p);
    if (bad) return no(bad);
    if (t.id === p.id) return no("You can't file a case against yourself.");
    if (t.isBot) return no("Bots can't be put on trial.");
    if (t.immune) return no(`${t.name} is the owner, an admin, or ranks above the bot, so the bot can't act on them.`);

    const track = this.trackOf(t);
    const step = findStep(this.policy, track, input.stepId);
    if (!step) {
      const options = stepsFor(this.policy, track).map((s) => s.label).join(", ");
      return no(`${t.name} is ${track === "member" ? "a member" : "a newcomer"}, so the options are: ${options}.`);
    }
    const level = this.level(t.id);
    if (track === "member" && !stepAllowed(step, level)) {
      const top = highestAllowedStep(this.policy, level);
      return no(`${t.name} is at level ${level}, so the most a case can ask for is ${top?.label ?? "a warning"}. Punishments go up one step at a time.`);
    }

    const lane = laneOf({ kind: "sanction", stepId: step.id });
    const openForTarget = this.openInLane(lane).find((c) => this.accusedOf(c).includes(t.id));
    if (openForTarget) return no(`There's already an open case about ${t.name} (case #${openForTarget.id}). Vote on that one.`);
    const openForProposer = this.openInLane(lane).find((c) => c.proposerId === p.id);
    if (openForProposer) return no(`You already have an open case (case #${openForProposer.id}). Wait for it to close.`);

    const recent = this.store.casesSince(now - Math.max(this.policy.retaliationLockHours * HOUR, 7 * DAY));
    const retaliation = recent.find(
      (c) => c.proposerId === t.id && this.accusedOf(c).includes(p.id) && c.filedAt > now - this.policy.retaliationLockHours * HOUR,
    );
    if (retaliation) {
      const until = retaliation.filedAt + this.policy.retaliationLockHours * HOUR;
      return no(`${t.name} filed case #${retaliation.id} against you, so you can't file against them until <t:${Math.ceil(until / 1000)}:f>. You can post a statement on that case instead.`);
    }
    const failed = recent.find(
      (c) =>
        c.kind === "sanction" &&
        c.status === "failed" &&
        c.targetId === t.id &&
        c.stepId === step.id &&
        (c.closedAt ?? 0) + step.retryAfterFailMinutes * MIN > now,
    );
    if (failed) {
      const until = (failed.closedAt ?? now) + step.retryAfterFailMinutes * MIN;
      return no(`A vote for ${step.label} on ${t.name} failed (case #${failed.id}). It can't be proposed again until <t:${Math.ceil(until / 1000)}:f>.`);
    }

    const voice = input.voice === "auto" ? t.voiceChannelId !== null : input.voice;
    let witnesses: string[] = [];
    if (voice) {
      const from = now - this.policy.witnessWindowMinutes * MIN;
      witnesses = [...witnessesOf(t.id, this.store.sessionsSince(from), from, now)];
      if (!witnesses.includes(p.id)) {
        return no(`For a voice case you need to have been in voice with ${t.name} in the last ${this.policy.witnessWindowMinutes} minutes.`);
      }
    }

    const requirement: Requirement = {
      yes: step.yes,
      share: step.share,
      witnessYes: voice ? Math.min(step.witnessYes, step.yes) : 0,
      closeOnThreshold: step.closeOnThreshold,
    };
    const electorate = this.electorate(input.members, [p.id, t.id], [t.id]);
    const tooFew = this.checkElectorate(electorate, witnesses, requirement);
    if (tooFew) return no(tooFew);

    return this.create(
      {
        kind: "sanction",
        track,
        stepId: step.id,
        targetId: t.id,
        partyBId: null,
        proposerId: p.id,
        rule: input.rule,
        reason: input.reason,
        voice,
        evidence: input.evidence,
        electorate,
        witnesses,
        requirement,
        targetLevel: track === "member" ? level : null,
        filedAt: now,
        closesAt: now + step.windowMinutes * MIN,
        shadow: this.shadow,
        appealOf: null,
      },
      this.breakerMessage(),
    );
  }

  fileNoContact(input: NoContactInput): Result<CaseRecord> {
    return this.store.tx(() => this.fileNoContactTx(input));
  }

  private fileNoContactTx(input: NoContactInput): Result<CaseRecord> {
    const { proposer: p, a, b } = input;
    const now = this.now();
    const rule = this.policy.noContact;
    const paused = this.checkBreaker();
    if (paused) return no(paused);
    const bad = this.checkProposer(p);
    if (bad) return no(bad);
    if (a.id === b.id) return no("A no-contact order needs two different people.");
    if (p.id === a.id || p.id === b.id) return no("A no-contact order has to be proposed by someone outside the feud.");
    for (const m of [a, b]) {
      if (m.isBot) return no("Bots can't be part of a no-contact order.");
      if (m.immune) return no(`${m.name} is the owner, an admin, or ranks above the bot, so the bot can't enforce an order on them.`);
    }
    const samePair = (c: { targetId: string; partyBId: string | null }) =>
      (c.targetId === a.id && c.partyBId === b.id) || (c.targetId === b.id && c.partyBId === a.id);
    if (this.store.activeNoContacts(now, this.shadow).some((o) => samePair({ targetId: o.aId, partyBId: o.bId }))) {
      return no(`${a.name} and ${b.name} already have a no-contact order.`);
    }
    const open = this.openInLane("nocontact");
    const pairOpen = open.find(samePair);
    if (pairOpen) return no(`There's already an open no-contact case for them (case #${pairOpen.id}).`);
    const mine = open.find((c) => c.proposerId === p.id);
    if (mine) return no(`You already have an open no-contact case (case #${mine.id}).`);
    const failed = this.store
      .casesSince(now - rule.retryAfterFailMinutes * MIN - 7 * DAY)
      .find((c) => c.kind === "nocontact" && c.status === "failed" && samePair(c) && (c.closedAt ?? 0) + rule.retryAfterFailMinutes * MIN > now);
    if (failed) {
      const until = (failed.closedAt ?? now) + rule.retryAfterFailMinutes * MIN;
      return no(`A no-contact vote for them failed (case #${failed.id}). Try again after <t:${Math.ceil(until / 1000)}:f>.`);
    }

    const requirement: Requirement = { yes: rule.yes, share: rule.share, witnessYes: 0, closeOnThreshold: false };
    const electorate = this.electorate(input.members, [p.id, a.id, b.id], [a.id, b.id]);
    const tooFew = this.checkElectorate(electorate, [], requirement);
    if (tooFew) return no(tooFew);

    return this.create(
      {
        kind: "nocontact",
        track: null,
        stepId: null,
        targetId: a.id,
        partyBId: b.id,
        proposerId: p.id,
        rule: null,
        reason: input.reason,
        voice: false,
        evidence: null,
        electorate,
        witnesses: [],
        requirement,
        targetLevel: null,
        filedAt: now,
        closesAt: now + rule.windowMinutes * MIN,
        shadow: this.shadow,
        appealOf: null,
      },
      this.breakerMessage(),
    );
  }

  fileAppeal(input: AppealInput): Result<CaseRecord> {
    return this.store.tx(() => this.fileAppealTx(input));
  }

  private fileAppealTx(input: AppealInput): Result<CaseRecord> {
    const { proposer: p, userId } = input;
    const now = this.now();
    const rule = this.policy.appeal;
    const paused = this.checkBreaker();
    if (paused) return no(paused);
    const bad = this.checkProposer(p);
    if (bad) return no(bad);
    const ban = this.store.activeBan(userId, this.shadow);
    if (!ban) return no("That person doesn't have an active ban from the bot.");

    const eligibleAt = ban.until === null ? ban.imposedAt + rule.permanentAfterDays * DAY : ban.imposedAt + (ban.until - ban.imposedAt) * rule.afterFractionOfBan;
    if (now < eligibleAt) return no(`This ban can be appealed from <t:${Math.ceil(eligibleAt / 1000)}:f>.`);

    const open = this.openInLane("appeal");
    const existing = open.find((c) => c.targetId === userId);
    if (existing) return no(`There's already an open appeal for them (case #${existing.id}).`);
    const mine = open.find((c) => c.proposerId === p.id);
    if (mine) return no(`You already have an open appeal (case #${mine.id}).`);
    const failed = this.store
      .casesSince(now - rule.retryAfterFailDays * DAY - 7 * DAY)
      .find((c) => c.kind === "appeal" && c.status === "failed" && c.appealOf === ban.caseId && (c.closedAt ?? 0) + rule.retryAfterFailDays * DAY > now);
    if (failed) {
      const until = (failed.closedAt ?? now) + rule.retryAfterFailDays * DAY;
      return no(`An appeal for this ban failed (case #${failed.id}). The next one can be filed from <t:${Math.ceil(until / 1000)}:f>.`);
    }

    const requirement: Requirement = { yes: rule.yes, share: rule.share, witnessYes: 0, closeOnThreshold: false };
    const electorate = this.electorate(input.members, [p.id, userId], [userId]);
    const tooFew = this.checkElectorate(electorate, [], requirement);
    if (tooFew) return no(tooFew);

    return this.create(
      {
        kind: "appeal",
        track: null,
        stepId: null,
        targetId: userId,
        partyBId: null,
        proposerId: p.id,
        rule: null,
        reason: input.reason,
        voice: false,
        evidence: null,
        electorate,
        witnesses: [],
        requirement,
        targetLevel: null,
        filedAt: now,
        closesAt: now + rule.windowMinutes * MIN,
        shadow: this.shadow,
        appealOf: ban.caseId,
      },
      this.breakerMessage(),
    );
  }

  private breakerMessage(): string {
    const { maxCasesPerHour, pauseMinutes } = this.policy.breaker;
    return `${maxCasesPerHour} cases were already filed in the last hour, so new cases are paused for ${pauseMinutes} minutes.`;
  }

  /** Banned users an appeal could be filed for, newest first. */
  appealable(): { userId: string; caseId: number; until: number | null }[] {
    return this.store.activeBans(this.shadow).map((b) => ({ userId: b.userId, caseId: b.caseId, until: b.until }));
  }

  // Voting ----------------------------------------------------------------

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
      if (!c) return no(`There's no case #${caseId}.`);
      if (c.status !== "open") return no(`Case #${caseId} is closed.`);
      if (this.now() >= c.closesAt) return no(`Voting on case #${caseId} has ended. The result will be posted in a moment.`);
      if (!c.electorate.includes(voterId)) return no(this.whyCantVote(c, voterId));
      const previous = this.store.votes(caseId).find((v) => v.voterId === voterId)?.value ?? null;
      this.store.castVote(caseId, voterId, value, this.now());
      const settled = this.settle(caseId, false);
      return ok({ case: settled?.case ?? this.store.getCase(caseId)!, previous, settled });
    });
  }

  /** Close every case whose deadline has passed. */
  closeDue(): Settled[] {
    const out: Settled[] = [];
    for (const c of this.store.dueCases(this.now())) {
      const s = this.store.tx(() => this.settle(c.id, true));
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Decide a case and, if decided, close it and record what passing means
   * (strikes, bans, orders) in the same transaction. Returns null if the case
   * is still open or something else already closed it.
   */
  private settle(caseId: number, final: boolean): Settled | null {
    const c = this.store.getCase(caseId);
    if (!c || c.status !== "open") return null;
    const t = this.tally(c);
    const decision = final ? (t.decision === "pass" ? "pass" : "fail") : t.decision;
    if (decision === "open") return null;
    const passed = decision === "pass";
    if (!this.store.closeCase(c.id, passed ? "passed" : "failed", this.now())) return null;
    const closed = this.store.getCase(c.id)!;
    return { case: closed, passed, effects: passed ? this.recordPassed(closed) : [] };
  }

  private recordPassed(c: CaseRecord): Effect[] {
    const now = this.now();
    if (c.kind === "nocontact") {
      const until = now + this.policy.noContact.days * DAY;
      this.store.addNoContact({ caseId: c.id, aId: c.targetId, bId: c.partyBId!, until, shadow: c.shadow });
      return [{ type: "noContact", aId: c.targetId, bId: c.partyBId!, until }];
    }
    if (c.kind === "appeal") {
      this.store.liftBan(c.targetId, now);
      this.store.cancelScheduled("unban", c.targetId, now);
      if (c.appealOf !== null) this.store.voidStrike(c.appealOf);
      return [{ type: "unban", userId: c.targetId }];
    }
    const step = findStep(this.policy, c.track ?? "member", c.stepId ?? "");
    if (!step) return [];
    const p = step.punishment;
    const endsAt = p.type === "timeout" ? now + p.minutes * MIN : p.type === "ban" ? (p.days === null ? null : now + p.days * DAY) : now;
    if (step.level !== null) this.store.addStrike({ userId: c.targetId, caseId: c.id, level: step.level, imposedAt: now, endsAt, shadow: c.shadow });
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

  // Housekeeping ----------------------------------------------------------

  /** Called when a ban is lifted outside the bot, for example by hand in Discord. */
  banLiftedElsewhere(userId: string) {
    this.store.tx(() => {
      const ban = this.store.activeBan(userId, false);
      if (!ban) return;
      this.store.liftBan(userId, this.now());
      this.store.cancelScheduled("unban", userId, this.now());
      this.store.endStrike(ban.caseId, this.now());
    });
  }

  purgeOldVoice() {
    this.store.purgeSessions(this.now() - this.policy.voiceRetentionDays * DAY);
  }
}
