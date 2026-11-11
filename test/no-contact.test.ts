import { Collection, type Client, type Message, type VoiceState } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { Court } from "../src/discord/court.js";
import { NoContactGuard } from "../src/discord/no-contact.js";
import { Store } from "../src/store.js";

const now = () => 1_000_000;

function setup(shadow = false) {
  const store = new Store(":memory:");
  store.addNoContact({ caseId: 4, aId: "A", bId: "B", until: now() + 1000, shadow });
  const logs: string[] = [];
  const court = { log: vi.fn(async (t: string) => void logs.push(t)) } as unknown as Court;
  const sent: string[] = [];
  const client = {
    users: { fetch: vi.fn(async () => ({ send: vi.fn(async (t: string) => void sent.push(t)) })) },
  } as unknown as Client;
  const guard = new NoContactGuard({ client, store, court, guildName: "Test", shadow, now });
  return { guard, logs, sent };
}

const message = (authorId: string, mentions: string[], repliedTo: string | null = null) => {
  const deleted = vi.fn(async () => undefined);
  const m = {
    author: { id: authorId },
    mentions: {
      users: new Collection(mentions.map((id) => [id, { id }])),
      repliedUser: repliedTo ? { id: repliedTo } : null,
    },
    delete: deleted,
  } as unknown as Message<true>;
  return { m, deleted };
};

describe("NoContactGuard", () => {
  it("removes a mention of the other party and reminds once", async () => {
    const { guard, logs, sent } = setup();
    const first = message("A", ["B"]);
    expect(await guard.onMessage(first.m)).toBe(true);
    expect(first.deleted).toHaveBeenCalled();
    expect(logs[0]).toContain("removed a message from <@A>");
    const second = message("A", [], "B");
    expect(await guard.onMessage(second.m)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("leaves unrelated messages alone", async () => {
    const { guard } = setup();
    const m = message("A", ["C"]);
    expect(await guard.onMessage(m.m)).toBe(false);
    expect(m.deleted).not.toHaveBeenCalled();
    const other = message("C", ["A", "B"]);
    expect(await guard.onMessage(other.m)).toBe(false);
  });

  it("in a trial run it logs and keeps the message", async () => {
    const { guard, logs } = setup(true);
    const m = message("B", ["A"]);
    expect(await guard.onMessage(m.m)).toBe(false);
    expect(m.deleted).not.toHaveBeenCalled();
    expect(logs[0]).toContain("trial run");
  });

  it("moves whoever joins the other's voice channel", async () => {
    const { guard, logs } = setup();
    const disconnect = vi.fn(async () => undefined);
    const state = {
      id: "B",
      channelId: "vc",
      guild: { voiceStates: { cache: new Collection([["A", { channelId: "vc" }]]) } },
      disconnect,
    } as unknown as VoiceState;
    await guard.onVoiceJoin(state);
    expect(disconnect).toHaveBeenCalled();
    expect(logs[0]).toContain("moved <@B> out of <#vc>");
    const elsewhere = {
      ...state,
      guild: { voiceStates: { cache: new Collection([["A", { channelId: "other" }]]) } },
    } as unknown as VoiceState;
    await guard.onVoiceJoin(elsewhere);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
