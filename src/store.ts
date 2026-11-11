import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Session } from "./engine/witness.js";
import type {
  BanRecord,
  CaseRecord,
  NewCase,
  NoContactRecord,
  PendingKind,
  PendingRecord,
  ScheduledKind,
  ScheduledRecord,
  StatementRecord,
  StrikeRecord,
  VoteRecord,
  VoteValue,
} from "./types.js";

/** What SQLite hands back for the column types this schema uses. */
type Cell = string | number | bigint | null;
type Row = Record<string, Cell>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE members (user_id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL);
  CREATE TABLE cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    track TEXT,
    step_id TEXT,
    target_id TEXT NOT NULL,
    party_b_id TEXT,
    proposer_id TEXT NOT NULL,
    rule TEXT,
    reason TEXT NOT NULL,
    voice INTEGER NOT NULL,
    evidence TEXT,
    electorate TEXT NOT NULL,
    witnesses TEXT NOT NULL,
    requirement TEXT NOT NULL,
    target_level INTEGER,
    filed_at INTEGER NOT NULL,
    closes_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    closed_at INTEGER,
    shadow INTEGER NOT NULL,
    appeal_of INTEGER,
    channel_id TEXT,
    message_id TEXT
  );
  CREATE INDEX cases_status ON cases(status, closes_at);
  CREATE INDEX cases_filed ON cases(filed_at);
  CREATE INDEX cases_closed ON cases(closed_at);
  CREATE TABLE votes (
    case_id INTEGER NOT NULL,
    voter_id TEXT NOT NULL,
    value TEXT NOT NULL,
    cast_at INTEGER NOT NULL,
    PRIMARY KEY (case_id, voter_id)
  );
  CREATE TABLE strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    case_id INTEGER NOT NULL,
    level INTEGER NOT NULL,
    imposed_at INTEGER NOT NULL,
    ends_at INTEGER,
    voided INTEGER NOT NULL DEFAULT 0,
    shadow INTEGER NOT NULL
  );
  CREATE INDEX strikes_user ON strikes(user_id);
  CREATE TABLE bans (
    user_id TEXT NOT NULL,
    case_id INTEGER NOT NULL,
    imposed_at INTEGER NOT NULL,
    until INTEGER,
    lifted_at INTEGER,
    shadow INTEGER NOT NULL
  );
  CREATE TABLE no_contact (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL,
    a_id TEXT NOT NULL,
    b_id TEXT NOT NULL,
    until INTEGER NOT NULL,
    shadow INTEGER NOT NULL
  );
  CREATE TABLE scheduled (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    user_id TEXT NOT NULL,
    case_id INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE TABLE pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    user_id TEXT NOT NULL,
    case_id INTEGER NOT NULL,
    minutes INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE voice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER
  );
  CREATE INDEX voice_open ON voice_sessions(user_id, left_at);
  CREATE TABLE statements (
    case_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (case_id, user_id)
  );
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

// Column decoding.
const bool = (v: Cell | undefined): boolean => v === 1 || v === 1n;
const num = (v: Cell | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: Cell | undefined): string | null => (v === null || v === undefined ? null : String(v));
const text = (v: Cell | undefined): string => String(v);
const json = <T>(v: Cell | undefined): T => JSON.parse(text(v)) as T;
const flag = (b: boolean): number => (b ? 1 : 0);

const toCase = (r: Row): CaseRecord => ({
  id: Number(r.id),
  kind: r.kind as CaseRecord["kind"],
  track: str(r.track) as CaseRecord["track"],
  stepId: str(r.step_id),
  targetId: text(r.target_id),
  partyBId: str(r.party_b_id),
  proposerId: text(r.proposer_id),
  rule: str(r.rule),
  reason: text(r.reason),
  voice: bool(r.voice),
  evidence: r.evidence ? json(r.evidence) : null,
  electorate: json(r.electorate),
  witnesses: json(r.witnesses),
  requirement: json(r.requirement),
  targetLevel: num(r.target_level),
  filedAt: Number(r.filed_at),
  closesAt: Number(r.closes_at),
  status: r.status as CaseRecord["status"],
  closedAt: num(r.closed_at),
  shadow: bool(r.shadow),
  appealOf: num(r.appeal_of),
  channelId: str(r.channel_id),
  messageId: str(r.message_id),
});

const toVote = (r: Row): VoteRecord => ({
  caseId: Number(r.case_id),
  voterId: text(r.voter_id),
  value: r.value as VoteValue,
  castAt: Number(r.cast_at),
});

const toStrike = (r: Row): StrikeRecord => ({
  id: Number(r.id),
  userId: text(r.user_id),
  caseId: Number(r.case_id),
  level: Number(r.level),
  imposedAt: Number(r.imposed_at),
  endsAt: num(r.ends_at),
  voided: bool(r.voided),
  shadow: bool(r.shadow),
});

const toBan = (r: Row): BanRecord => ({
  userId: text(r.user_id),
  caseId: Number(r.case_id),
  imposedAt: Number(r.imposed_at),
  until: num(r.until),
  liftedAt: num(r.lifted_at),
  shadow: bool(r.shadow),
});

const toNoContact = (r: Row): NoContactRecord => ({
  id: Number(r.id),
  caseId: Number(r.case_id),
  aId: text(r.a_id),
  bId: text(r.b_id),
  until: Number(r.until),
  shadow: bool(r.shadow),
});

const toScheduled = (r: Row): ScheduledRecord => ({
  id: Number(r.id),
  kind: r.kind as ScheduledKind,
  userId: text(r.user_id),
  caseId: Number(r.case_id),
  dueAt: Number(r.due_at),
});

const toPending = (r: Row): PendingRecord => ({
  id: Number(r.id),
  kind: r.kind as PendingKind,
  userId: text(r.user_id),
  caseId: Number(r.case_id),
  minutes: num(r.minutes),
  createdAt: Number(r.created_at),
});

const toSession = (r: Row): Session => ({
  userId: text(r.user_id),
  channelId: text(r.channel_id),
  joinedAt: Number(r.joined_at),
  leftAt: num(r.left_at),
});

const toStatement = (r: Row): StatementRecord => ({
  caseId: Number(r.case_id),
  userId: text(r.user_id),
  text: text(r.text),
  at: Number(r.at),
});

/**
 * All persistence, on Node's built-in SQLite. Methods are synchronous; the
 * engine wraps related calls in tx() so a check and its write are atomic.
 */
export class Store {
  readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  close(): void {
    this.db.close();
  }

  /** Run fn in a write transaction. Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // Members -----------------------------------------------------------------

  /** Remember the earliest time we saw someone in the server. Leaving and rejoining does not reset it. */
  seen(userId: string, at: number): void {
    this.run(
      `INSERT INTO members (user_id, first_seen_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at)`,
      userId,
      at,
    );
  }

  firstSeen(userId: string): number | null {
    return num(this.get("SELECT first_seen_at FROM members WHERE user_id = ?", userId)?.first_seen_at);
  }

  // Cases -------------------------------------------------------------------

  insertCase(c: NewCase): CaseRecord {
    const result = this.db
      .prepare(
        `INSERT INTO cases (kind, track, step_id, target_id, party_b_id, proposer_id, rule, reason, voice, evidence,
           electorate, witnesses, requirement, target_level, filed_at, closes_at, shadow, appeal_of)
         VALUES ($kind, $track, $stepId, $targetId, $partyBId, $proposerId, $rule, $reason, $voice, $evidence,
           $electorate, $witnesses, $requirement, $targetLevel, $filedAt, $closesAt, $shadow, $appealOf)`,
      )
      .run({
        $kind: c.kind,
        $track: c.track,
        $stepId: c.stepId,
        $targetId: c.targetId,
        $partyBId: c.partyBId,
        $proposerId: c.proposerId,
        $rule: c.rule,
        $reason: c.reason,
        $voice: flag(c.voice),
        $evidence: c.evidence ? JSON.stringify(c.evidence) : null,
        $electorate: JSON.stringify(c.electorate),
        $witnesses: JSON.stringify(c.witnesses),
        $requirement: JSON.stringify(c.requirement),
        $targetLevel: c.targetLevel,
        $filedAt: c.filedAt,
        $closesAt: c.closesAt,
        $shadow: flag(c.shadow),
        $appealOf: c.appealOf,
      });
    return this.getCase(Number(result.lastInsertRowid))!;
  }

  getCase(id: number): CaseRecord | null {
    const r = this.get("SELECT * FROM cases WHERE id = ?", id);
    return r ? toCase(r) : null;
  }

  openCases(): CaseRecord[] {
    return this.all("SELECT * FROM cases WHERE status = 'open' ORDER BY id").map(toCase);
  }

  dueCases(now: number): CaseRecord[] {
    return this.all("SELECT * FROM cases WHERE status = 'open' AND closes_at <= ? ORDER BY id", now).map(toCase);
  }

  casesSince(since: number): CaseRecord[] {
    return this.all("SELECT * FROM cases WHERE filed_at >= ? ORDER BY id", since).map(toCase);
  }

  /** Cases closed after `since`, most recently closed first. */
  casesClosedAfter(since: number): CaseRecord[] {
    return this.all("SELECT * FROM cases WHERE closed_at > ? ORDER BY closed_at DESC", since).map(toCase);
  }

  countCasesSince(since: number): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM cases WHERE filed_at >= ?", since)?.n ?? 0);
  }

  /** Move an open case to passed or failed. Returns false if something else closed it first. */
  closeCase(id: number, status: "passed" | "failed", at: number): boolean {
    const r = this.run("UPDATE cases SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'", status, at, id);
    return r.changes === 1;
  }

  setCaseMessage(id: number, channelId: string, messageId: string): void {
    this.run("UPDATE cases SET channel_id = ?, message_id = ? WHERE id = ?", channelId, messageId, id);
  }

  // Votes -------------------------------------------------------------------

  castVote(caseId: number, voterId: string, value: VoteValue, at: number): void {
    this.run(
      `INSERT INTO votes (case_id, voter_id, value, cast_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(case_id, voter_id) DO UPDATE SET value = excluded.value, cast_at = excluded.cast_at`,
      caseId,
      voterId,
      value,
      at,
    );
  }

  votes(caseId: number): VoteRecord[] {
    return this.all("SELECT * FROM votes WHERE case_id = ? ORDER BY cast_at", caseId).map(toVote);
  }

  // Strikes -----------------------------------------------------------------

  addStrike(s: Omit<StrikeRecord, "id" | "voided">): void {
    this.run(
      "INSERT INTO strikes (user_id, case_id, level, imposed_at, ends_at, shadow) VALUES (?, ?, ?, ?, ?, ?)",
      s.userId,
      s.caseId,
      s.level,
      s.imposedAt,
      s.endsAt,
      flag(s.shadow),
    );
  }

  strikes(userId: string, shadow: boolean): StrikeRecord[] {
    return this.all(
      "SELECT * FROM strikes WHERE user_id = ? AND shadow = ? AND voided = 0 ORDER BY imposed_at",
      userId,
      flag(shadow),
    ).map(toStrike);
  }

  voidStrike(caseId: number): void {
    this.run("UPDATE strikes SET voided = 1 WHERE case_id = ?", caseId);
  }

  /** End a strike early, used when a ban is lifted ahead of schedule. */
  endStrike(caseId: number, at: number): void {
    this.run("UPDATE strikes SET ends_at = ? WHERE case_id = ? AND (ends_at IS NULL OR ends_at > ?)", at, caseId, at);
  }

  // Bans --------------------------------------------------------------------

  addBan(b: Omit<BanRecord, "liftedAt">): void {
    this.run(
      "INSERT INTO bans (user_id, case_id, imposed_at, until, shadow) VALUES (?, ?, ?, ?, ?)",
      b.userId,
      b.caseId,
      b.imposedAt,
      b.until,
      flag(b.shadow),
    );
  }

  activeBan(userId: string, shadow: boolean): BanRecord | null {
    const r = this.get(
      "SELECT * FROM bans WHERE user_id = ? AND shadow = ? AND lifted_at IS NULL ORDER BY imposed_at DESC LIMIT 1",
      userId,
      flag(shadow),
    );
    return r ? toBan(r) : null;
  }

  activeBans(shadow: boolean): BanRecord[] {
    return this.all(
      "SELECT * FROM bans WHERE shadow = ? AND lifted_at IS NULL ORDER BY imposed_at DESC",
      flag(shadow),
    ).map(toBan);
  }

  liftBan(userId: string, at: number): void {
    this.run("UPDATE bans SET lifted_at = ? WHERE user_id = ? AND lifted_at IS NULL", at, userId);
  }

  // No-contact orders -------------------------------------------------------

  addNoContact(o: Omit<NoContactRecord, "id">): void {
    this.run(
      "INSERT INTO no_contact (case_id, a_id, b_id, until, shadow) VALUES (?, ?, ?, ?, ?)",
      o.caseId,
      o.aId,
      o.bId,
      o.until,
      flag(o.shadow),
    );
  }

  activeNoContacts(now: number, shadow: boolean): NoContactRecord[] {
    return this.all("SELECT * FROM no_contact WHERE until > ? AND shadow = ?", now, flag(shadow)).map(toNoContact);
  }

  // Scheduled and pending actions -------------------------------------------

  schedule(kind: ScheduledKind, userId: string, caseId: number, dueAt: number): void {
    this.run("INSERT INTO scheduled (kind, user_id, case_id, due_at) VALUES (?, ?, ?, ?)", kind, userId, caseId, dueAt);
  }

  dueScheduled(now: number): ScheduledRecord[] {
    return this.all("SELECT * FROM scheduled WHERE done_at IS NULL AND due_at <= ? ORDER BY due_at", now).map(
      toScheduled,
    );
  }

  /** Claim a scheduled action. Returns false if something else already ran it. */
  finishScheduled(id: number, at: number): boolean {
    return this.run("UPDATE scheduled SET done_at = ? WHERE id = ? AND done_at IS NULL", at, id).changes === 1;
  }

  cancelScheduled(kind: ScheduledKind, userId: string, at: number): void {
    this.run("UPDATE scheduled SET done_at = ? WHERE kind = ? AND user_id = ? AND done_at IS NULL", at, kind, userId);
  }

  addPending(kind: PendingKind, userId: string, caseId: number, minutes: number | null, at: number): void {
    this.run(
      "INSERT INTO pending (kind, user_id, case_id, minutes, created_at) VALUES (?, ?, ?, ?, ?)",
      kind,
      userId,
      caseId,
      minutes,
      at,
    );
  }

  pending(userId: string, kind: PendingKind): PendingRecord[] {
    return this.all("SELECT * FROM pending WHERE user_id = ? AND kind = ? ORDER BY created_at", userId, kind).map(
      toPending,
    );
  }

  /** Claim a pending action. Returns false if something else already took it. */
  takePending(id: number): boolean {
    return this.run("DELETE FROM pending WHERE id = ?", id).changes === 1;
  }

  // Voice -------------------------------------------------------------------

  voiceJoin(userId: string, channelId: string, at: number): void {
    this.voiceLeave(userId, at);
    this.run("INSERT INTO voice_sessions (user_id, channel_id, joined_at) VALUES (?, ?, ?)", userId, channelId, at);
  }

  voiceLeave(userId: string, at: number): void {
    this.run("UPDATE voice_sessions SET left_at = ? WHERE user_id = ? AND left_at IS NULL", at, userId);
  }

  /** Close every open session, for startup after downtime. */
  voiceLeaveAll(at: number): void {
    this.run("UPDATE voice_sessions SET left_at = MAX(joined_at, ?) WHERE left_at IS NULL", at);
  }

  sessionsSince(since: number): Session[] {
    return this.all("SELECT * FROM voice_sessions WHERE left_at IS NULL OR left_at >= ? ORDER BY joined_at", since).map(
      toSession,
    );
  }

  purgeSessions(before: number): void {
    this.run("DELETE FROM voice_sessions WHERE left_at IS NOT NULL AND left_at < ?", before);
  }

  // Statements --------------------------------------------------------------

  setStatement(caseId: number, userId: string, text: string, at: number): void {
    this.run(
      `INSERT INTO statements (case_id, user_id, text, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(case_id, user_id) DO UPDATE SET text = excluded.text, at = excluded.at`,
      caseId,
      userId,
      text,
      at,
    );
  }

  statements(caseId: number): StatementRecord[] {
    return this.all("SELECT * FROM statements WHERE case_id = ? ORDER BY at", caseId).map(toStatement);
  }

  // Key/value state ---------------------------------------------------------

  getState(key: string): string | null {
    return str(this.get("SELECT value FROM state WHERE key = ?", key)?.value);
  }

  setState(key: string, value: string): void {
    this.run(
      "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}
