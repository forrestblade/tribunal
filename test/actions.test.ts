import { describe, expect, it, vi } from "vitest";
import type { Guild, GuildMember } from "discord.js";
import { applyEffect, applyPendingTimeouts } from "../src/discord/actions.js";
import { DEFAULT_POLICY as P } from "../src/policy.js";
import { Store } from "../src/store.js";
import type { CaseRecord } from "../src/types.js";

const now = () => 1_000_000;
const c = { id: 3, rule: "No spam", reason: "spam", kind: "sanction" } as CaseRecord;

/** A guild that records what the bot does. */
function fakeGuild(opts: { member?: Partial<GuildMember> | null; dmFails?: boolean } = {}) {
  const calls: string[] = [];
  const member =
    opts.member === null
      ? null
      : {
          id: "T",
          voice: { channelId: "vc", disconnect: vi.fn(async () => calls.push("disconnect")) },
          timeout: vi.fn(async (ms: number) => calls.push(`timeout:${ms}`)),
          kick: vi.fn(async () => calls.push("kick")),
          ...opts.member,
        };
  const guild = {
    name: "Test",
    members: {
      fetch: vi.fn(async () => {
        if (!member) {
          const { DiscordAPIError } = await import("discord.js");
          throw new DiscordAPIError({ message: "Unknown Member", code: 10007 }, 10007, 404, "GET", "", {});
        }
        return member;
      }),
      ban: vi.fn(async () => calls.push("ban")),
      unban: vi.fn(async () => calls.push("unban")),
    },
    client: {
      users: {
        fetch: vi.fn(async () => ({
          send: vi.fn(async () => {
            if (opts.dmFails) throw new Error("Cannot send messages to this user");
            calls.push("dm");
          }),
        })),
      },
    },
  };
  return { guild: guild as unknown as Guild, calls, member };
}

describe("applyEffect", () => {
  it("DMs first, then bans", async () => {
    const { guild, calls } = fakeGuild();
    const { notes } = await applyEffect({ type: "ban", userId: "T", days: 30 }, c, guild, new Store(":memory:"), P, false, now);
    expect(calls).toEqual(["dm", "ban"]);
    expect(notes).toEqual([]);
  });

  it("times out and pulls them from voice", async () => {
    const { guild, calls } = fakeGuild();
    await applyEffect({ type: "timeout", userId: "T", minutes: 60 }, c, guild, new Store(":memory:"), P, false, now);
    expect(calls).toEqual(["dm", "timeout:3600000", "disconnect"]);
  });

  it("notes closed DMs but still acts", async () => {
    const { guild, calls } = fakeGuild({ dmFails: true });
    const { notes } = await applyEffect({ type: "kick", userId: "T" }, c, guild, new Store(":memory:"), P, false, now);
    expect(calls).toEqual(["kick"]);
    expect(notes[0]).toContain("Could not DM");
  });

  it("stores a pending timeout when they have left", async () => {
    const { guild, calls } = fakeGuild({ member: null });
    const store = new Store(":memory:");
    const { notes } = await applyEffect({ type: "timeout", userId: "T", minutes: 60 }, c, guild, store, P, false, now);
    expect(calls).toEqual(["dm"]);
    expect(notes[0]).toContain("left the server");
    expect(store.pending("T", "timeout")).toMatchObject([{ minutes: 60, caseId: 3 }]);
  });

  it("applies the pending timeout when they come back, once", async () => {
    const store = new Store(":memory:");
    store.addPending("timeout", "T", 3, 60, 0);
    const timeout = vi.fn(async () => undefined);
    const member = { id: "T", timeout } as unknown as GuildMember;
    await applyPendingTimeouts(member, store);
    await applyPendingTimeouts(member, store);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(3_600_000, expect.stringContaining("case #3"));
  });

  it("in a trial run it only DMs", async () => {
    const { guild, calls } = fakeGuild();
    await applyEffect({ type: "ban", userId: "T", days: null }, c, guild, new Store(":memory:"), P, true, now);
    expect(calls).toEqual(["dm"]);
    const { calls: calls2, guild: g2 } = fakeGuild();
    await applyEffect({ type: "unban", userId: "T" }, c, g2, new Store(":memory:"), P, true, now);
    expect(calls2).toEqual([]);
  });

  it("warnings are a DM and nothing else", async () => {
    const { guild, calls } = fakeGuild();
    await applyEffect({ type: "warn", userId: "T" }, c, guild, new Store(":memory:"), P, false, now);
    expect(calls).toEqual(["dm"]);
  });
});
