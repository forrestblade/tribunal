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

type Row = Record<string, SQLInputValue>;

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
    message_id TEXT,
    thread_id TEXT
  );
  CREATE INDEX cases_status ON cases(status, closes_at);
  CREATE INDEX cases_filed ON cases(filed_at);
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

const bool = (v: unknown) => v === 1 || v === 1n;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toCase(r: Row): CaseRecord {
  return {
    id: Number(r.id),
    kind: r.kind as CaseRecord["kind"],
    track: str(r.track) as CaseRecord["track"],
    stepId: str(r.step_id),
    targetId: String(r.target_id),
    partyBId: str(r.party_b_id),
    proposerId: String(r.proposer_id),
    rule: str(r.rule),
    reason: String(r.reason),
    voice: bool(r.voice),
    evidence: r.evidence ? JSON.parse(String(r.evidence)) : null,
    electorate: JSON.parse(String(r.electorate)),
    witnesses: JSON.parse(String(r.witnesses)),
    requirement: JSON.parse(String(r.requirement)),
    targetLevel: num(r.target_level),
    filedAt: Number(r.filed_at),
    closesAt: Number(r.closes_at),
    status: r.status as CaseRecord["status"],
    closedAt: num(r.closed_at),
    shadow: bool(r.shadow),
    appealOf: num(r.appeal_of),
    channelId: str(r.channel_id),
    messageId: str(r.message_id),
    threadId: str(r.thread_id),
  };
}

const toStrike = (r: Row): StrikeRecord => ({
  id: Number(r.id),
  userId: String(r.user_id),
  caseId: Number(r.case_id),
  level: Number(r.level),
  imposedAt: Number(r.imposed_at),
  endsAt: num(r.ends_at),
  voided: bool(r.voided),
  shadow: bool(r.shadow),
});

const toBan = (r: Row): BanRecord => ({
  userId: String(r.user_id),
  caseId: Number(r.case_id),
  imposedAt: Number(r.imposed_at),
  until: num(r.until),
  liftedAt: num(r.lifted_at),
  shadow: bool(r.shadow),
});

const toSession = (r: Row): Session => ({
  userId: String(r.user_id),
  channelId: String(r.channel_id),
  joinedAt: Number(r.joined_at),
  leftAt: num(r.left_at),
});

export class Store {
  readonly db: DatabaseSync;

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

  close() {
    this.db.close();
  }

  /** Run fn in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  private depth = 0;

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // Members ---------------------------------------------------------------

  /** Remember the earliest time we know someone was in the server. Leaving and rejoining does not reset it. */
  seen(userId: string, at: number) {
    this.run(
      "INSERT INTO members (user_id, first_seen_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at)",
      userId,
      at,
    );
  }

  firstSeen(userId: string): number | null {
    return num(this.get("SELECT first_seen_at FROM members WHERE user_id = ?", userId)?.first_seen_at);
  }

  // Cases -----------------------------------------------------------------

  insertCase(c: NewCase): CaseRecord {
    const r = this.run(
      `INSERT INTO cases (kind, track, step_id, target_id, party_b_id, proposer_id, rule, reason, voice, evidence,
        electorate, witnesses, requirement, target_level, filed_at, closes_at, shadow, appeal_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.kind,
      c.track,
      c.stepId,
      c.targetId,
      c.partyBId,
      c.proposerId,
      c.rule,
      c.reason,
      c.voice ? 1 : 0,
      c.evidence ? JSON.stringify(c.evidence) : null,
      JSON.stringify(c.electorate),
      JSON.stringify(c.witnesses),
      JSON.stringify(c.requirement),
      c.targetLevel,
      c.filedAt,
      c.closesAt,
      c.shadow ? 1 : 0,
      c.appealOf,
    );
    return this.getCase(Number(r.lastInsertRowid))!;
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

  /** Atomically move an open case to passed or failed. Returns false if it was already closed. */
  closeCase(id: number, status: "passed" | "failed", at: number): boolean {
    return this.run("UPDATE cases SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'", status, at, id).changes === 1;
  }

  setCaseMessage(id: number, channelId: string, messageId: string, threadId: string | null) {
    this.run("UPDATE cases SET channel_id = ?, message_id = ?, thread_id = ? WHERE id = ?", channelId, messageId, threadId, id);
  }

  // Votes -----------------------------------------------------------------

  castVote(caseId: number, voterId: string, value: VoteValue, at: number) {
    this.run(
      "INSERT INTO votes (case_id, voter_id, value, cast_at) VALUES (?, ?, ?, ?) ON CONFLICT(case_id, voter_id) DO UPDATE SET value = excluded.value, cast_at = excluded.cast_at",
      caseId,
      voterId,
      value,
      at,
    );
  }

  votes(caseId: number): VoteRecord[] {
    return this.all("SELECT * FROM votes WHERE case_id = ? ORDER BY cast_at", caseId).map((r) => ({
      caseId: Number(r.case_id),
      voterId: String(r.voter_id),
      value: r.value as VoteValue,
      castAt: Number(r.cast_at),
    }));
  }

  // Strikes ---------------------------------------------------------------

  addStrike(s: Omit<StrikeRecord, "id" | "voided">) {
    this.run(
      "INSERT INTO strikes (user_id, case_id, level, imposed_at, ends_at, shadow) VALUES (?, ?, ?, ?, ?, ?)",
      s.userId,
      s.caseId,
      s.level,
      s.imposedAt,
      s.endsAt,
      s.shadow ? 1 : 0,
    );
  }

  strikes(userId: string, shadow: boolean): StrikeRecord[] {
    return this.all("SELECT * FROM strikes WHERE user_id = ? AND shadow = ? AND voided = 0 ORDER BY imposed_at", userId, shadow ? 1 : 0).map(toStrike);
  }

  voidStrike(caseId: number) {
    this.run("UPDATE strikes SET voided = 1 WHERE case_id = ?", caseId);
  }

  /** End a strike early, used when a ban is lifted ahead of schedule. */
  endStrike(caseId: number, at: number) {
    this.run("UPDATE strikes SET ends_at = ? WHERE case_id = ? AND (ends_at IS NULL OR ends_at > ?)", at, caseId, at);
  }

  // Bans ------------------------------------------------------------------

  addBan(b: Omit<BanRecord, "liftedAt">) {
    this.run("INSERT INTO bans (user_id, case_id, imposed_at, until, shadow) VALUES (?, ?, ?, ?, ?)", b.userId, b.caseId, b.imposedAt, b.until, b.shadow ? 1 : 0);
  }

  activeBan(userId: string, shadow: boolean): BanRecord | null {
    const r = this.get("SELECT * FROM bans WHERE user_id = ? AND shadow = ? AND lifted_at IS NULL ORDER BY imposed_at DESC LIMIT 1", userId, shadow ? 1 : 0);
    return r ? toBan(r) : null;
  }

  activeBans(shadow: boolean): BanRecord[] {
    return this.all("SELECT * FROM bans WHERE shadow = ? AND lifted_at IS NULL ORDER BY imposed_at DESC", shadow ? 1 : 0).map(toBan);
  }

  liftBan(userId: string, at: number) {
    this.run("UPDATE bans SET lifted_at = ? WHERE user_id = ? AND lifted_at IS NULL", at, userId);
  }

  // No-contact orders -----------------------------------------------------

  addNoContact(o: Omit<NoContactRecord, "id">) {
    this.run("INSERT INTO no_contact (case_id, a_id, b_id, until, shadow) VALUES (?, ?, ?, ?, ?)", o.caseId, o.aId, o.bId, o.until, o.shadow ? 1 : 0);
  }

  activeNoContacts(now: number, shadow: boolean): NoContactRecord[] {
    return this.all("SELECT * FROM no_contact WHERE until > ? AND shadow = ?", now, shadow ? 1 : 0).map((r) => ({
      id: Number(r.id),
      caseId: Number(r.case_id),
      aId: String(r.a_id),
      bId: String(r.b_id),
      until: Number(r.until),
      shadow: bool(r.shadow),
    }));
  }

  // Scheduled and pending actions -----------------------------------------

  schedule(kind: ScheduledKind, userId: string, caseId: number, dueAt: number) {
    this.run("INSERT INTO scheduled (kind, user_id, case_id, due_at) VALUES (?, ?, ?, ?)", kind, userId, caseId, dueAt);
  }

  dueScheduled(now: number): ScheduledRecord[] {
    return this.all("SELECT * FROM scheduled WHERE done_at IS NULL AND due_at <= ? ORDER BY due_at", now).map((r) => ({
      id: Number(r.id),
      kind: r.kind as ScheduledKind,
      userId: String(r.user_id),
      caseId: Number(r.case_id),
      dueAt: Number(r.due_at),
    }));
  }

  /** Mark a scheduled action done. Returns false if something else already did. */
  finishScheduled(id: number, at: number): boolean {
    return this.run("UPDATE scheduled SET done_at = ? WHERE id = ? AND done_at IS NULL", at, id).changes === 1;
  }

  cancelScheduled(kind: ScheduledKind, userId: string, at: number) {
    this.run("UPDATE scheduled SET done_at = ? WHERE kind = ? AND user_id = ? AND done_at IS NULL", at, kind, userId);
  }

  addPending(kind: PendingKind, userId: string, caseId: number, minutes: number | null, at: number) {
    this.run("INSERT INTO pending (kind, user_id, case_id, minutes, created_at) VALUES (?, ?, ?, ?, ?)", kind, userId, caseId, minutes, at);
  }

  pending(userId: string, kind: PendingKind): PendingRecord[] {
    return this.all("SELECT * FROM pending WHERE user_id = ? AND kind = ? ORDER BY created_at", userId, kind).map((r) => ({
      id: Number(r.id),
      kind: r.kind as PendingKind,
      userId: String(r.user_id),
      caseId: Number(r.case_id),
      minutes: num(r.minutes),
      createdAt: Number(r.created_at),
    }));
  }

  /** Delete a pending action. Returns false if it was already taken. */
  takePending(id: number): boolean {
    return this.run("DELETE FROM pending WHERE id = ?", id).changes === 1;
  }

  // Voice -----------------------------------------------------------------

  voiceJoin(userId: string, channelId: string, at: number) {
    this.voiceLeave(userId, at);
    this.run("INSERT INTO voice_sessions (user_id, channel_id, joined_at) VALUES (?, ?, ?)", userId, channelId, at);
  }

  voiceLeave(userId: string, at: number) {
    this.run("UPDATE voice_sessions SET left_at = ? WHERE user_id = ? AND left_at IS NULL", at, userId);
  }

  /** Close every open session, for startup after downtime. */
  voiceLeaveAll(at: number) {
    this.run("UPDATE voice_sessions SET left_at = MAX(joined_at, ?) WHERE left_at IS NULL", at);
  }

  sessionsSince(since: number): Session[] {
    return this.all("SELECT * FROM voice_sessions WHERE left_at IS NULL OR left_at >= ? ORDER BY joined_at", since).map(toSession);
  }

  purgeSessions(before: number) {
    this.run("DELETE FROM voice_sessions WHERE left_at IS NOT NULL AND left_at < ?", before);
  }

  // Statements ------------------------------------------------------------

  setStatement(caseId: number, userId: string, text: string, at: number) {
    this.run(
      "INSERT INTO statements (case_id, user_id, text, at) VALUES (?, ?, ?, ?) ON CONFLICT(case_id, user_id) DO UPDATE SET text = excluded.text, at = excluded.at",
      caseId,
      userId,
      text,
      at,
    );
  }

  statements(caseId: number): StatementRecord[] {
    return this.all("SELECT * FROM statements WHERE case_id = ? ORDER BY at", caseId).map((r) => ({
      caseId: Number(r.case_id),
      userId: String(r.user_id),
      text: String(r.text),
      at: Number(r.at),
    }));
  }

  // Key/value state -------------------------------------------------------

  getState(key: string): string | null {
    return str(this.get("SELECT value FROM state WHERE key = ?", key)?.value);
  }

  setState(key: string, value: string) {
    this.run("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
}
