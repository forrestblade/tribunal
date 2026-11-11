import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import type { NewCase } from "../src/types.js";

const newCase = (over: Partial<NewCase> = {}): NewCase => ({
  kind: "sanction",
  track: "member",
  stepId: "warn",
  targetId: "T",
  partyBId: null,
  proposerId: "P",
  rule: "Be decent",
  reason: "rude",
  voice: false,
  evidence: { url: "https://discord.com/x", authorId: "T", content: "hi", attachments: [] },
  electorate: ["A", "B"],
  witnesses: [],
  requirement: { yes: 3, share: "majority", witnessYes: 0, closeOnThreshold: false },
  targetLevel: 0,
  filedAt: 1000,
  closesAt: 2000,
  shadow: false,
  appealOf: null,
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Store", () => {
  it("round-trips a case with its JSON fields", () => {
    const s = new Store(":memory:");
    const c = s.insertCase(newCase());
    expect(c.id).toBe(1);
    expect(c.status).toBe("open");
    expect(c.evidence?.content).toBe("hi");
    expect(c.electorate).toEqual(["A", "B"]);
    expect(c.requirement.share).toBe("majority");
    expect(c.voice).toBe(false);
  });

  it("closes a case once", () => {
    const s = new Store(":memory:");
    const c = s.insertCase(newCase());
    expect(s.closeCase(c.id, "passed", 1500)).toBe(true);
    expect(s.closeCase(c.id, "failed", 1600)).toBe(false);
    expect(s.getCase(c.id)?.status).toBe("passed");
  });

  it("lists due cases", () => {
    const s = new Store(":memory:");
    s.insertCase(newCase({ closesAt: 2000 }));
    s.insertCase(newCase({ closesAt: 3000 }));
    expect(s.dueCases(2500).map((c) => c.id)).toEqual([1]);
  });

  it("lets a voter change their vote", () => {
    const s = new Store(":memory:");
    s.insertCase(newCase());
    s.castVote(1, "A", "yes", 1);
    s.castVote(1, "A", "no", 2);
    expect(s.votes(1)).toEqual([{ caseId: 1, voterId: "A", value: "no", castAt: 2 }]);
  });

  it("keeps the earliest first-seen time", () => {
    const s = new Store(":memory:");
    s.seen("A", 500);
    s.seen("A", 900);
    s.seen("A", 100);
    expect(s.firstSeen("A")).toBe(100);
    expect(s.firstSeen("nobody")).toBeNull();
  });

  it("takes a pending action only once", () => {
    const s = new Store(":memory:");
    s.addPending("timeout", "A", 1, 60, 0);
    const [p] = s.pending("A", "timeout");
    expect(s.takePending(p!.id)).toBe(true);
    expect(s.takePending(p!.id)).toBe(false);
  });

  it("tracks voice sessions across moves", () => {
    const s = new Store(":memory:");
    s.voiceJoin("A", "vc1", 0);
    s.voiceJoin("A", "vc2", 10);
    s.voiceLeave("A", 20);
    expect(s.sessionsSince(0)).toEqual([
      { userId: "A", channelId: "vc1", joinedAt: 0, leftAt: 10 },
      { userId: "A", channelId: "vc2", joinedAt: 10, leftAt: 20 },
    ]);
    s.purgeSessions(15);
    expect(s.sessionsSince(0)).toHaveLength(1);
  });

  it("rolls back a failed transaction", () => {
    const s = new Store(":memory:");
    expect(() =>
      s.tx(() => {
        s.insertCase(newCase());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.openCases()).toHaveLength(0);
  });

  it("survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribunal-"));
    dirs.push(dir);
    const path = join(dir, "nested", "t.db");
    const a = new Store(path);
    a.insertCase(newCase());
    a.schedule("unban", "T", 1, 5000);
    a.close();
    const b = new Store(path);
    expect(b.getCase(1)?.reason).toBe("rude");
    expect(b.dueScheduled(6000)).toHaveLength(1);
    b.close();
  });
});
