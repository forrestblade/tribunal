import { DiscordAPIError, type Guild, type GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { Actions } from "../src/discord/actions.js";
import { DEFAULT_POLICY as P } from "../src/policy.js";
import { Store } from "../src/store.js";
import type { CaseRecord } from "../src/types.js";

const now = () => 1_000_000;
const c = { id: 3, rule: "No spam", reason: "spam", kind: "sanction" } as CaseRecord;

/** A guild that records what the bot does to it. */
function fakeGuild(opts: { memberPresent?: boolean; dmFails?: boolean } = {}) {
  const calls: string[] = [];
  const member = {
    id: "T",
    voice: { channelId: "vc", disconnect: vi.fn(async () => calls.push("disconnect")) },
    timeout: vi.fn(async (ms: number) => calls.push(`timeout:${ms}`)),
    kick: vi.fn(async () => calls.push("kick")),
  };
  const guild = {
    name: "Test",
    members: {
      fetch: vi.fn(async () => {
        if (opts.memberPresent === false) {
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

const actions = (guild: Guild, store = new Store(":memory:"), shadow = false) =>
  new Actions({ guild, store, policy: P, shadow, now });

describe("Actions", () => {
  it("DMs first, then bans", async () => {
    const { guild, calls } = fakeGuild();
    const notes = await actions(guild).apply({ type: "ban", userId: "T", days: 30 }, c);
    expect(calls).toEqual(["dm", "ban"]);
    expect(notes).toEqual([]);
  });

  it("times out and pulls them from voice", async () => {
    const { guild, calls } = fakeGuild();
    await actions(guild).apply({ type: "timeout", userId: "T", minutes: 60 }, c);
    expect(calls).toEqual(["dm", "timeout:3600000", "disconnect"]);
  });

  it("notes closed DMs but still acts", async () => {
    const { guild, calls } = fakeGuild({ dmFails: true });
    const notes = await actions(guild).apply({ type: "kick", userId: "T" }, c);
    expect(calls).toEqual(["kick"]);
    expect(notes[0]).toContain("Could not DM");
  });

  it("stores a pending timeout when they have left", async () => {
    const { guild, calls } = fakeGuild({ memberPresent: false });
    const store = new Store(":memory:");
    const notes = await actions(guild, store).apply({ type: "timeout", userId: "T", minutes: 60 }, c);
    expect(calls).toEqual(["dm"]);
    expect(notes[0]).toContain("left the server");
    expect(store.pending("T", "timeout")).toMatchObject([{ minutes: 60, caseId: 3 }]);
  });

  it("applies the owed timeout when they come back, once", async () => {
    const { guild } = fakeGuild();
    const store = new Store(":memory:");
    store.addPending("timeout", "T", 3, 60, 0);
    const timeout = vi.fn(async () => undefined);
    const member = { id: "T", timeout } as unknown as GuildMember;
    const a = actions(guild, store);
    await a.applyOwed(member);
    await a.applyOwed(member);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(3_600_000, expect.stringContaining("case #3"));
  });

  it("in a trial run it only DMs", async () => {
    const { guild, calls } = fakeGuild();
    await actions(guild, new Store(":memory:"), true).apply({ type: "ban", userId: "T", days: null }, c);
    expect(calls).toEqual(["dm"]);
    const second = fakeGuild();
    await actions(second.guild, new Store(":memory:"), true).apply({ type: "unban", userId: "T" }, c);
    expect(second.calls).toEqual([]);
  });

  it("warnings are a DM and nothing else", async () => {
    const { guild, calls } = fakeGuild();
    await actions(guild).apply({ type: "warn", userId: "T" }, c);
    expect(calls).toEqual(["dm"]);
  });

  it("applyAll keeps going when one effect throws", async () => {
    const { guild, calls } = fakeGuild();
    (guild.members.ban as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Missing Permissions"));
    const notes = await actions(guild).applyAll(
      [
        { type: "ban", userId: "T", days: 30 },
        { type: "warn", userId: "T" },
      ],
      c,
    );
    expect(notes).toEqual(["Could not apply ban: Missing Permissions"]);
    expect(calls).toEqual(["dm", "dm"]);
  });

  it("treats an already-lifted ban as a note, not an error", async () => {
    const { guild } = fakeGuild();
    (guild.members.unban as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DiscordAPIError({ message: "Unknown Ban", code: 10026 }, 10026, 404, "DELETE", "", {}),
    );
    const notes = await actions(guild).apply({ type: "unban", userId: "T" }, c);
    expect(notes).toEqual(["They were not banned in Discord any more."]);
  });
});
