import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { buildCommands } from "../src/discord/commands.js";
import { closedCard, effectText, helpText, logLine, openCard } from "../src/discord/render.js";
import { DEFAULT_POLICY as P } from "../src/policy.js";
import { Store } from "../src/store.js";
import type { CaseRecord } from "../src/types.js";

const now = Date.UTC(2026, 2, 1, 12);
const caseOf = (over: Partial<CaseRecord> = {}): CaseRecord => ({
  id: 7,
  kind: "sanction",
  track: "member",
  stepId: "timeout-1h",
  targetId: "T",
  partyBId: null,
  proposerId: "P",
  rule: "No spam",
  reason: "posted the same link nine times",
  voice: false,
  evidence: {
    channelId: "2",
    messageId: "3",
    url: "https://discord.com/channels/1/2/3",
    authorId: "T",
    content: "buy now",
    attachments: [{ name: "a.png", url: "https://cdn/a.png", size: 1 }],
  },
  electorate: ["A", "B", "C", "D", "E", "F"],
  witnesses: [],
  requirement: { yes: 4, share: "two-thirds", witnessYes: 0, closeOnThreshold: false },
  targetLevel: 1,
  filedAt: now,
  closesAt: now + 15 * 60_000,
  status: "open",
  closedAt: null,
  shadow: false,
  appealOf: null,
  channelId: "2",
  messageId: "9",
  ...over,
});

const engineWith = (c: CaseRecord, votes: [string, "yes" | "no"][]) => {
  const store = new Store(":memory:");
  const engine = new Engine(store, P, false, () => now);
  const saved = store.insertCase(c);
  for (const [v, value] of votes) store.castVote(saved.id, v, value, now);
  return { engine, store, saved };
};

describe("openCard", () => {
  it("shows the case, hides the tally and offers Yes, No and Statement", () => {
    const { engine, saved } = engineWith(caseOf(), [
      ["A", "yes"],
      ["B", "no"],
    ]);
    const card = openCard(saved, P, engine.tally(saved), []);
    const embed = card.embeds[0]!.toJSON();
    expect(embed.title).toBe("Case #1: Timeout 1h");
    expect(embed.description).toContain("<@T> (level 1) is accused by <@P>");
    const fields = Object.fromEntries(embed.fields!.map((f) => [f.name, f.value]));
    expect(fields.Turnout).toBe("2 of 6 have voted");
    expect(fields.Needs).toBe("4 yes, at least 2/3 yes");
    expect(fields.Evidence).toContain("> buy now");
    expect(fields.Evidence).toContain("[a.png](https://cdn/a.png)");
    expect(JSON.stringify(embed)).not.toMatch(/1 yes|1 no/);
    const buttons = card.components[0]!.toJSON().components.map((b) => (b as { custom_id: string }).custom_id);
    expect(buttons).toEqual(["vote:1:yes", "vote:1:no", "statement:1"]);
  });

  it("marks trial runs and shows witness requirements and statements", () => {
    const c = caseOf({
      shadow: true,
      voice: true,
      witnesses: ["A", "B"],
      requirement: { yes: 4, share: "two-thirds", witnessYes: 2, closeOnThreshold: false },
    });
    const { engine, saved } = engineWith(c, []);
    const embed = openCard(saved, P, engine.tally(saved), [
      { caseId: 1, userId: "T", text: "it was one link", at: now },
    ]).embeds[0]!.toJSON();
    expect(embed.footer?.text).toContain("Trial run");
    const fields = Object.fromEntries(embed.fields!.map((f) => [f.name, f.value]));
    expect(fields.Needs).toContain("2 yes from people who were in voice");
    expect(fields.Statement).toContain("it was one link");
  });

  it("has no statement button on appeals", () => {
    const { engine, saved } = engineWith(
      caseOf({ kind: "appeal", stepId: null, track: null, appealOf: 3, rule: null, evidence: null }),
      [],
    );
    const card = openCard(saved, P, engine.tally(saved), []);
    expect(card.components[0]!.toJSON().components).toHaveLength(2);
    expect(card.embeds[0]!.toJSON().title).toBe("Case #1: Appeal");
  });
});

describe("closedCard and logLine", () => {
  it("names every voter and says what was done", () => {
    const { engine, store, saved } = engineWith(caseOf(), [
      ["A", "yes"],
      ["B", "yes"],
      ["C", "yes"],
      ["D", "yes"],
      ["E", "no"],
    ]);
    store.closeCase(saved.id, "passed", now + 1);
    const closed = store.getCase(saved.id)!;
    const tally = engine.tally(closed);
    const card = closedCard(
      closed,
      P,
      tally,
      [],
      [{ type: "timeout", userId: "T", minutes: 60 }],
      ["Could not DM them (DMs closed)."],
    );
    const fields = Object.fromEntries(card.embeds[0]!.toJSON().fields!.map((f) => [f.name, f.value]));
    expect(fields.Result).toBe("Passed");
    expect(fields.Yes).toBe("<@A> <@B> <@C> <@D>");
    expect(fields.No).toBe("<@E>");
    expect(fields.Action).toBe("Timed out <@T> for 1h.\nCould not DM them (DMs closed).");
    expect(card.components).toEqual([]);
    expect(logLine(closed, P, tally, [{ type: "timeout", userId: "T", minutes: 60 }], [])).toBe(
      "Case #1: Timeout 1h passed 4-1. Timed out <@T> for 1h.",
    );
  });

  it("says would in trial runs", () => {
    expect(effectText({ type: "ban", userId: "T", days: null }, true)).toBe("Would ban <@T> permanently.");
    expect(effectText({ type: "ban", userId: "T", days: 30 }, false)).toBe("Banned <@T> for 30 days.");
    expect(effectText({ type: "cooloff", userId: "T", minutes: 10 }, true)).toBe("Would time out <@T> for 10 minutes.");
  });
});

describe("helpText and commands", () => {
  it("explains the ladder from the policy", () => {
    const text = helpText(P, ["Be decent"], true);
    expect(text).toContain("Trial run");
    expect(text).toContain("Timeout 7 days: 6 yes, at least 2/3 yes, 1 day to vote (level 4)");
    expect(text).toContain("Be decent");
  });

  it("builds the slash commands with every step as a choice", () => {
    const cmds = buildCommands(P, ["Be decent"]);
    expect(cmds.map((c) => c.name)).toEqual([
      "case",
      "nocontact",
      "appeal",
      "record",
      "status",
      "help",
      "File a case",
      "File a case about this",
    ]);
    const caseCmd = cmds[0] as { options: { name: string; choices?: { value: string }[] }[] };
    const punishment = caseCmd.options.find((o) => o.name === "punishment")!;
    expect(punishment.choices!.map((c) => c.value)).toEqual([
      "cooloff",
      "warn",
      "timeout-1h",
      "timeout-24h",
      "timeout-7d",
      "ban-30d",
      "ban",
      "kick",
    ]);
  });
});
