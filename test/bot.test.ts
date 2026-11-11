// Drives the bot through fake Discord objects: a slash command files a case, buttons vote,
// the card updates, the case settles, the punishment is applied and the log is written.
import { Collection, Events, type Interaction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { Bot } from "../src/discord/bot.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/store.js";

const DAY = 86_400_000;
let now = Date.UTC(2026, 2, 1, 12);
const clock = () => now;

const config = parseConfig({ applicationId: "1", guildId: "100", courtChannelId: "200", logChannelId: "300", shadow: false }, { DISCORD_TOKEN: "t" });

interface FakeMember {
  id: string;
  displayName: string;
  user: { id: string; bot: boolean; username: string };
  joinedTimestamp: number;
  communicationDisabledUntilTimestamp: number | null;
  voice: { channelId: string | null; disconnect: ReturnType<typeof vi.fn> };
  roles: { highest: { comparePositionTo: (o: unknown) => number } };
  permissions: { has: () => boolean };
  guild: { ownerId: string; members: { me: unknown } };
  timeout: ReturnType<typeof vi.fn>;
  kick: ReturnType<typeof vi.fn>;
}

function world() {
  const calls: string[] = [];
  const guild = {
    id: "100",
    name: "Test",
    ownerId: "owner",
    members: { me: { roles: { highest: {} } }, fetch: vi.fn(), ban: vi.fn(async () => calls.push("ban")), unban: vi.fn(async () => calls.push("unban")) },
    channels: { fetch: vi.fn() },
    voiceStates: { cache: new Collection() },
    client: { users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => calls.push("dm")) })) } },
  };
  const members = new Collection<string, FakeMember>();
  const addMember = (id: string, over: Partial<FakeMember> = {}) => {
    const m: FakeMember = {
      id,
      displayName: id,
      user: { id, bot: false, username: id },
      joinedTimestamp: now - 100 * DAY,
      communicationDisabledUntilTimestamp: null,
      voice: { channelId: null, disconnect: vi.fn() },
      roles: { highest: { comparePositionTo: () => -1 } },
      permissions: { has: () => false },
      guild,
      timeout: vi.fn(async (ms: number) => calls.push(`timeout:${id}:${ms}`)),
      kick: vi.fn(async () => calls.push(`kick:${id}`)),
      ...over,
    };
    members.set(id, m);
    return m;
  };
  guild.members.fetch = vi.fn(async (id?: string) => (id ? members.get(id) ?? Promise.reject(new Error("Unknown Member")) : members));

  const posted: { id: string; payload: unknown; edits: unknown[] }[] = [];
  const court = {
    send: vi.fn(async (payload: unknown) => {
      const msg = { id: `m${posted.length + 1}`, channelId: "200", payload, edits: [] as unknown[] };
      posted.push(msg);
      return msg;
    }),
    messages: { fetch: vi.fn(async (id: string) => {
      const msg = posted.find((p) => p.id === id);
      return msg ? { edit: vi.fn(async (payload: unknown) => msg.edits.push(payload)) } : Promise.reject(new Error("Unknown Message"));
    }) },
  };
  const logs: string[] = [];
  const logChannel = { send: vi.fn(async (p: { content: string }) => logs.push(p.content)) };

  const store = new Store(":memory:");
  const engine = new Engine(store, config.policy, config.shadow, clock);
  const bot = new Bot(config, store, engine, clock);
  const priv = bot as unknown as { guild: unknown; court: unknown; logChannel: unknown; tick: () => Promise<void> };
  priv.guild = guild;
  priv.court = court;
  priv.logChannel = logChannel;
  Object.defineProperty(bot.client, "user", { value: { id: "bot", tag: "bot#0" } });
  bot.client.users.fetch = guild.client.users.fetch as never;

  const emit = async (i: Partial<Interaction> & Record<string, unknown>) => {
    const base = {
      inGuild: () => true,
      guildId: "100",
      isChatInputCommand: () => false,
      isUserContextMenuCommand: () => false,
      isMessageContextMenuCommand: () => false,
      isButton: () => false,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      isRepliable: () => true,
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    const full = { ...base, ...i };
    bot.client.emit(Events.InteractionCreate, full as unknown as Interaction);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return full;
  };
  const slash = (commandName: string, user: string, opts: Record<string, unknown>) =>
    emit({
      isChatInputCommand: () => true,
      commandName,
      user: { id: user },
      options: {
        getUser: (n: string) => ({ id: opts[n] }),
        getString: (n: string) => (opts[n] as string) ?? null,
        getBoolean: (n: string) => (opts[n] as boolean) ?? null,
      },
    } as never);
  const button = (customId: string, user: string) => emit({ isButton: () => true, customId, user: { id: user } } as never);

  return { bot, store, engine, guild, addMember, members, calls, posted, logs, emit, slash, button, tick: () => priv.tick() };
}

const ids = ["P", "T", ...Array.from({ length: 13 }, (_, i) => `V${i + 1}`)];
let w: ReturnType<typeof world>;

beforeEach(() => {
  now = Date.UTC(2026, 2, 1, 12);
  w = world();
  for (const id of ids) w.addMember(id);
});

describe("Bot", () => {
  it("files a case from /case, takes votes, settles and acts", async () => {
    const filed = await w.slash("case", "P", { who: "T", punishment: "warn", reason: "rude", rule: "Be decent" });
    expect(filed.deferReply).toHaveBeenCalled();
    expect(filed.editReply).toHaveBeenCalledWith(expect.stringContaining("Filed case #1"));
    expect(w.posted).toHaveLength(1);
    const card = w.posted[0]!.payload as { content: string; embeds: { toJSON: () => { title: string } }[] };
    expect(card.content).toBe("<@T>");
    expect(card.embeds[0]!.toJSON().title).toBe("Case #1: Warning");

    const self = await w.button("vote:1:yes", "P");
    expect(self.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("filed this case") }));

    const v1 = await w.button("vote:1:yes", "V1");
    expect(v1.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Recorded **yes**. 1 of 13") }));
    expect(w.posted[0]!.edits).toHaveLength(1);

    await w.button("vote:1:yes", "V2");
    await w.button("vote:1:yes", "V3");
    expect(w.store.getCase(1)?.status).toBe("open");

    now += 31 * 60_000;
    await w.tick();
    expect(w.store.getCase(1)?.status).toBe("passed");
    expect(w.calls).toEqual(["dm"]);
    expect(w.logs[0]).toBe("Case #1: Warning passed 3-0. Warned <@T> by DM.");
    const last = w.posted[0]!.edits.at(-1) as { components: unknown[]; embeds: { toJSON: () => { fields: { name: string; value: string }[] } }[] };
    expect(last.components).toEqual([]);
    expect(last.embeds[0]!.toJSON().fields.find((f) => f.name === "Yes")?.value).toBe("<@V1> <@V2> <@V3>");
    expect(w.engine.level("T")).toBe(1);
  });

  it("explains refusals instead of filing", async () => {
    const r = await w.slash("case", "P", { who: "T", punishment: "ban", reason: "rude" });
    expect(r.editReply).toHaveBeenCalledWith(expect.stringContaining("most a case can ask for is Warning"));
    expect(w.posted).toHaveLength(0);
  });

  it("closes a cool-off at 3 yes and times them out", async () => {
    w.members.get("T")!.voice.channelId = "vc";
    await w.slash("case", "P", { who: "T", punishment: "cooloff", reason: "yelling", voice: false });
    await w.button("vote:1:yes", "V1");
    await w.button("vote:1:yes", "V2");
    await w.button("vote:1:yes", "V3");
    expect(w.store.getCase(1)?.status).toBe("passed");
    expect(w.calls).toEqual(["dm", "timeout:T:600000"]);
    expect(w.members.get("T")!.voice.disconnect).toHaveBeenCalled();
  });

  it("lifts a temporary ban when it is due", async () => {
    w.store.addStrike({ userId: "T", caseId: 1, level: 5, imposedAt: now, endsAt: now + DAY, shadow: false });
    w.store.insertCase({ kind: "sanction", track: "member", stepId: "ban-30d", targetId: "T", partyBId: null, proposerId: "P", rule: null, reason: "x", voice: false, evidence: null, electorate: [], witnesses: [], requirement: { yes: 1, share: "majority", witnessYes: 0, closeOnThreshold: false }, targetLevel: 4, filedAt: now, closesAt: now, shadow: false, appealOf: null });
    w.store.closeCase(1, "passed", now);
    w.store.addBan({ userId: "T", caseId: 1, imposedAt: now, until: now + DAY, shadow: false });
    w.store.schedule("unban", "T", 1, now + DAY);
    await w.tick();
    expect(w.calls).toEqual([]);
    now += DAY;
    await w.tick();
    expect(w.calls).toEqual(["unban"]);
    expect(w.store.activeBan("T", false)).toBeNull();
    expect(w.logs[0]).toContain("time served");
  });

  it("answers /status and /record without touching Discord", async () => {
    await w.slash("case", "P", { who: "T", punishment: "warn", reason: "rude" });
    const status = await w.slash("status", "V1", {});
    expect(status.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Case #1") }));
    const record = await w.slash("record", "V1", { who: "T" });
    const embed = (record.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0].embeds[0].toJSON();
    expect(embed.title).toBe("Record for T");
    expect(embed.description).toContain("Level **0**");
  });

  it("only lets the accused post a statement", async () => {
    await w.slash("case", "P", { who: "T", punishment: "warn", reason: "rude" });
    const stranger = await w.button("stmt:1", "V1");
    expect(stranger.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Only the people the case is about") }));
    const showModal = vi.fn(async () => undefined);
    await w.emit({ isButton: () => true, customId: "stmt:1", user: { id: "T" }, showModal } as never);
    expect(showModal).toHaveBeenCalled();
    const submit = await w.emit({ isModalSubmit: () => true, customId: "stmt:1", user: { id: "T" }, fields: { getTextInputValue: () => "it was a joke" } } as never);
    expect(submit.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "Your statement is on the card." }));
    expect(w.store.statements(1)[0]?.text).toBe("it was a joke");
  });
});
