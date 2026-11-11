import { beforeEach, describe, expect, it } from "vitest";
import { Engine, type MemberInfo, type Settled } from "../src/engine/engine.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { Store } from "../src/store.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 2, 1, 12);

const member = (id: string, over: Partial<MemberInfo> = {}): MemberInfo => ({
  id,
  name: id,
  isBot: false,
  immune: false,
  joinedAt: T0 - 100 * DAY,
  timedOutUntil: null,
  voiceChannelId: null,
  ...over,
});

/** 15 members: P (proposer), T (target), and V1..V13 voters. */
const ids = ["P", "T", ...Array.from({ length: 13 }, (_, i) => `V${i + 1}`)];
let members: MemberInfo[];
let store: Store;
let engine: Engine;
let now: number;

const by = (id: string) => members.find((m) => m.id === id)!;
const file = (stepId: string, over: Record<string, unknown> = {}) =>
  engine.fileSanction({
    proposer: by("P"),
    target: by("T"),
    stepId,
    rule: "Be decent",
    reason: "rude",
    voice: false,
    evidence: null,
    members,
    ...over,
  });
const expectOk = <T>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};
const expectNo = (r: { ok: boolean; reason?: string }, text: string) => {
  expect(r.ok).toBe(false);
  expect((r as { reason: string }).reason).toContain(text);
};
const voteYes = (caseId: number, voters: string[]) => voters.map((v) => expectOk(engine.vote(caseId, v, "yes")));

beforeEach(() => {
  now = T0;
  members = ids.map((id) => member(id));
  store = new Store(":memory:");
  engine = new Engine(store, DEFAULT_POLICY, false, () => now);
});

describe("filing", () => {
  it("files a warning for a clean member and freezes the voter list", () => {
    const c = expectOk(file("warn"));
    expect(c.stepId).toBe("warn");
    expect(c.electorate).not.toContain("P");
    expect(c.electorate).not.toContain("T");
    expect(c.electorate).toHaveLength(13);
    expect(c.closesAt).toBe(now + 30 * MIN);
    expect(c.requirement).toEqual({ yes: 3, share: "majority", witnessYes: 0, closeOnThreshold: false });
  });

  it("refuses to skip ladder steps", () => {
    expectNo(file("timeout-24h"), "most a case can ask for is Warning");
  });

  it("refuses bots, self, the immune, and newcomers as proposers", () => {
    expectNo(file("warn", { target: by("P") }), "yourself");
    expectNo(file("warn", { target: member("bot", { isBot: true }) }), "Bots");
    expectNo(file("warn", { target: member("owner", { immune: true }) }), "owner");
    expectNo(file("warn", { proposer: member("new", { joinedAt: now - DAY }) }), "14 days");
    expectNo(file("warn", { proposer: member("P", { timedOutUntil: now + HOUR }) }), "timed out");
  });

  it("puts newcomers on their own track", () => {
    members.push(member("N", { joinedAt: now - 2 * DAY }));
    expectNo(file("warn", { target: by("N") }), "newcomer");
    const c = expectOk(file("kick", { target: by("N") }));
    expect(c.track).toBe("newcomer");
    expect(c.requirement.yes).toBe(3);
    expect(c.electorate).not.toContain("N");
  });

  it("treats a rejoined member by their first sighting, not the new join date", () => {
    store.seen("T", now - 60 * DAY);
    members = members.map((m) => (m.id === "T" ? member("T", { joinedAt: now - DAY }) : m));
    expect(engine.trackOf(by("T"))).toBe("member");
  });

  it("allows one open case per person per lane, but a cool-off alongside", () => {
    expectOk(file("warn"));
    expectNo(file("warn"), "already an open case");
    expectNo(
      engine.fileSanction({
        proposer: by("V1"),
        target: by("T"),
        stepId: "warn",
        rule: null,
        reason: "x",
        voice: false,
        evidence: null,
        members,
      }),
      "already an open case",
    );
    expectNo(file("warn", { target: by("V2") }), "You already have an open case");
    expectOk(file("cooloff"));
  });

  it("blocks retaliation for 24 hours", () => {
    expectOk(file("warn"));
    const back = engine.fileSanction({
      proposer: by("T"),
      target: by("P"),
      stepId: "warn",
      rule: null,
      reason: "no u",
      voice: false,
      evidence: null,
      members,
    });
    expectNo(back, "can't file against them until");
    now += 24 * HOUR + 1;
    expectOk(
      engine.fileSanction({
        proposer: by("T"),
        target: by("P"),
        stepId: "warn",
        rule: null,
        reason: "no u",
        voice: false,
        evidence: null,
        members,
      }),
    );
  });

  it("keeps involved people off the voter list", () => {
    // V1 filed against T yesterday, and T filed against V2.
    expectOk(
      engine.fileSanction({
        proposer: by("V1"),
        target: by("T"),
        stepId: "warn",
        rule: null,
        reason: "x",
        voice: false,
        evidence: null,
        members,
      }),
    );
    expectOk(
      engine.fileSanction({
        proposer: by("T"),
        target: by("V2"),
        stepId: "warn",
        rule: null,
        reason: "x",
        voice: false,
        evidence: null,
        members,
      }),
    );
    engine.closeDue();
    now += 31 * MIN;
    engine.closeDue();
    const c = expectOk(file("cooloff"));
    expect(c.electorate).not.toContain("V1");
    expect(c.electorate).not.toContain("V2");
    expect(c.electorate).toContain("V3");
  });

  it("waits after a failed vote before the same step can be proposed again", () => {
    const c = expectOk(file("warn"));
    now += 31 * MIN;
    engine.closeDue();
    expect(store.getCase(c.id)?.status).toBe("failed");
    expectNo(file("warn"), "can't be proposed again until");
    now += DAY;
    expectOk(file("warn"));
  });

  it("refuses a case that could never pass", () => {
    members = members.slice(0, 4);
    expectNo(file("warn"), "couldn't pass");
  });

  it("trips the breaker after 5 cases in an hour", () => {
    for (let i = 1; i <= 5; i++) expectOk(file("warn", { target: by(`V${i}`), proposer: by(`V${i + 5}`) }));
    const r = engine.fileSanction({
      proposer: by("P"),
      target: by("T"),
      stepId: "warn",
      rule: null,
      reason: "x",
      voice: false,
      evidence: null,
      members,
    });
    expect(r.ok).toBe(false);
    expect((r as { breakerTripped?: boolean }).breakerTripped).toBe(true);
    expectNo(file("cooloff"), "paused until");
    now += 61 * MIN;
    expectOk(file("cooloff"));
  });
});

describe("voting and settling", () => {
  it("passes a warning at the deadline with 3 yes and a majority", () => {
    const c = expectOk(file("warn"));
    voteYes(c.id, ["V1", "V2", "V3"]);
    expectOk(engine.vote(c.id, "V4", "no"));
    expect(engine.tally(store.getCase(c.id)!).decision).toBe("open");
    now = c.closesAt;
    const [s] = engine.closeDue();
    expect(s?.passed).toBe(true);
    expect(s?.effects).toEqual([{ type: "warn", userId: "T" }]);
    expect(engine.level("T")).toBe(1);
  });

  it("rejects votes from the proposer, the target and outsiders, and after the deadline", () => {
    const c = expectOk(file("warn"));
    expectNo(engine.vote(c.id, "P", "yes"), "filed this case");
    expectNo(engine.vote(c.id, "T", "no"), "about you");
    expectNo(engine.vote(c.id, "nobody", "yes"), "not on this case's voter list");
    now = c.closesAt;
    expectNo(engine.vote(c.id, "V1", "yes"), "has ended");
  });

  it("lets a voter change their mind", () => {
    const c = expectOk(file("warn"));
    expectOk(engine.vote(c.id, "V1", "yes"));
    const o = expectOk(engine.vote(c.id, "V1", "no"));
    expect(o.previous).toBe("yes");
    expect(engine.tally(store.getCase(c.id)!)).toMatchObject({ yes: 0, no: 1 });
  });

  it("closes a cool-off the moment it hits 3 yes", () => {
    const c = expectOk(file("cooloff"));
    const [, , third] = voteYes(c.id, ["V1", "V2", "V3"]);
    expect(third!.settled?.passed).toBe(true);
    expect(third!.settled?.effects).toEqual([{ type: "cooloff", userId: "T", minutes: 10 }]);
    expect(engine.level("T")).toBe(0);
    expectNo(engine.vote(c.id, "V4", "yes"), "closed");
  });

  it("closes early when the result cannot change", () => {
    const c = expectOk(file("warn"));
    // 13 voters: 7 no makes a majority impossible.
    const outcomes = ["V1", "V2", "V3", "V4", "V5", "V6", "V7"].map((v) => expectOk(engine.vote(c.id, v, "no")));
    expect(outcomes.at(-1)!.settled?.passed).toBe(false);
    expect(store.getCase(c.id)?.status).toBe("failed");
  });

  it("climbs the ladder one step at a time and records bans with an unban job", () => {
    const pass = (stepId: string): Settled => {
      const c = expectOk(file(stepId));
      let settled: Settled | null = null;
      for (const v of c.electorate) {
        settled = expectOk(engine.vote(c.id, v, "yes")).settled;
        if (settled) break;
      }
      if (!settled) {
        now = c.closesAt;
        settled = engine.closeDue()[0] ?? null;
      }
      if (!settled?.passed) throw new Error(`${stepId} did not pass`);
      return settled;
    };
    pass("warn");
    pass("timeout-1h");
    now += HOUR;
    pass("timeout-24h");
    now += DAY;
    pass("timeout-7d");
    now += 7 * DAY;
    expectNo(file("ban"), "most a case can ask for is Ban 30 days");
    const ban = pass("ban-30d");
    expect(ban.effects).toEqual([{ type: "ban", userId: "T", days: 30 }]);
    expect(store.activeBan("T", false)?.until).toBe(now + 30 * DAY);
    expect(store.dueScheduled(now + 30 * DAY)).toMatchObject([{ kind: "unban", userId: "T" }]);
  });

  it("needs witness yes votes on a voice case", () => {
    const from = now - 10 * MIN;
    store.voiceJoin("T", "vc", from);
    store.voiceJoin("P", "vc", from);
    store.voiceJoin("V1", "vc", from);
    store.voiceJoin("V2", "vc", from);
    members = members.map((m) => (["T", "P", "V1", "V2"].includes(m.id) ? { ...m, voiceChannelId: "vc" } : m));
    const c = expectOk(file("warn", { voice: "auto" }));
    expect(c.voice).toBe(true);
    expect(c.witnesses.sort()).toEqual(["P", "V1", "V2"]);
    expect(c.requirement.witnessYes).toBe(2);
    voteYes(c.id, ["V3", "V4", "V5", "V6"]);
    now = c.closesAt;
    expect(engine.closeDue()[0]?.passed).toBe(false);
  });

  it("refuses a voice case from someone who was not there", () => {
    store.voiceJoin("T", "vc", now - 5 * MIN);
    store.voiceJoin("V1", "vc", now - 5 * MIN);
    store.voiceJoin("V2", "vc", now - 5 * MIN);
    expectNo(file("warn", { voice: true }), "need to have been in voice");
  });
});

describe("no-contact and appeals", () => {
  it("files and enforces a no-contact order between two people", () => {
    const c = expectOk(engine.fileNoContact({ proposer: by("V1"), a: by("P"), b: by("T"), reason: "feud", members }));
    expect(c.electorate).not.toContain("P");
    expect(c.electorate).not.toContain("T");
    expect(c.electorate).not.toContain("V1");
    voteYes(c.id, ["V2", "V3", "V4", "V5"]);
    now = c.closesAt;
    const [s] = engine.closeDue();
    expect(s?.effects[0]).toMatchObject({ type: "noContact", aId: "P", bId: "T" });
    expect(store.activeNoContacts(now, false)).toHaveLength(1);
    expectNo(
      engine.fileNoContact({ proposer: by("V1"), a: by("T"), b: by("P"), reason: "again", members }),
      "already have a no-contact order",
    );
  });

  it("must be proposed from outside the feud", () => {
    expectNo(
      engine.fileNoContact({ proposer: by("P"), a: by("P"), b: by("T"), reason: "x", members }),
      "outside the feud",
    );
  });

  it("appeals a ban after half of it has passed and voids the strike", () => {
    store.addStrike({ userId: "T", caseId: 1, level: 5, imposedAt: now, endsAt: now + 30 * DAY, shadow: false });
    store.addBan({ userId: "T", caseId: 1, imposedAt: now, until: now + 30 * DAY, shadow: false });
    store.schedule("unban", "T", 1, now + 30 * DAY);
    expectNo(engine.fileAppeal({ proposer: by("P"), userId: "T", reason: "sorry", members }), "can be appealed from");
    now += 15 * DAY;
    const c = expectOk(engine.fileAppeal({ proposer: by("P"), userId: "T", reason: "sorry", members }));
    voteYes(c.id, ["V1", "V2", "V3", "V4", "V5"]);
    now = c.closesAt;
    const [s] = engine.closeDue();
    expect(s?.effects).toEqual([{ type: "unban", userId: "T" }]);
    expect(store.activeBan("T", false)).toBeNull();
    expect(store.dueScheduled(now + 100 * DAY)).toHaveLength(0);
    expect(engine.level("T")).toBe(0);
  });

  it("waits 30 days after a failed appeal", () => {
    store.addBan({ userId: "T", caseId: 1, imposedAt: now - 40 * DAY, until: null, shadow: false });
    const c = expectOk(engine.fileAppeal({ proposer: by("P"), userId: "T", reason: "sorry", members }));
    now = c.closesAt;
    engine.closeDue();
    expectNo(
      engine.fileAppeal({ proposer: by("V1"), userId: "T", reason: "sorry", members }),
      "can't be proposed again until",
    );
  });
});

describe("shadow mode", () => {
  it("keeps shadow strikes apart from real ones", () => {
    const shadow = new Engine(store, DEFAULT_POLICY, true, () => now);
    const c = expectOk(
      shadow.fileSanction({
        proposer: by("P"),
        target: by("T"),
        stepId: "warn",
        rule: null,
        reason: "x",
        voice: false,
        evidence: null,
        members,
      }),
    );
    ["V1", "V2", "V3"].forEach((v) => expectOk(shadow.vote(c.id, v, "yes")));
    now = c.closesAt;
    shadow.closeDue();
    expect(shadow.level("T")).toBe(1);
    expect(engine.level("T")).toBe(0);
  });
});
