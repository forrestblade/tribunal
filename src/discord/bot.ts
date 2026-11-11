// Owns the Discord client: connects, wires events to the parts that handle
// them, and runs the clock. Everything else lives in the other files here.
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type PartialMessage,
  type VoiceState,
} from "discord.js";
import type { Config } from "../config.js";
import type { Engine } from "../engine/engine.js";
import { logger } from "../logger.js";
import type { Store } from "../store.js";
import { Actions } from "./actions.js";
import { Court } from "./court.js";
import { Drafts } from "./drafts.js";
import { Interactions } from "./interactions.js";
import { MentionFiling } from "./mentions.js";
import { NoContactGuard } from "./no-contact.js";
import { fetchMembers } from "./members.js";

const TICK_MS = 15_000;
const PURGE_EVERY = 24 * 60 * 60_000;

/** The parts that exist once the client is connected and the guild is known. */
interface Live {
  guild: Guild;
  court: Court;
  actions: Actions;
  interactions: Interactions;
  mentions: MentionFiling;
  noContact: NoContactGuard;
  drafts: Drafts;
}

export class Bot {
  readonly client: Client;
  private live: Live | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastPurge = 0;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly now: () => number = Date.now,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
      ],
    });
    this.client.once(Events.ClientReady, () => void this.onReady().catch((e) => this.fatal("could not start", e)));
    this.client.on(Events.InteractionCreate, (i) => void this.live?.interactions.handle(i));
    this.client.on(Events.MessageCreate, (m) => void this.guard("message", () => this.onMessage(m)));
    this.client.on(Events.VoiceStateUpdate, (a, b) => void this.guard("voice", () => this.onVoice(a, b)));
    this.client.on(Events.GuildMemberAdd, (m) => void this.guard("member add", () => this.onMemberAdd(m)));
    this.client.on(
      Events.GuildBanRemove,
      (b) => void this.guard("ban remove", () => this.engine.banLiftedElsewhere(b.user.id)),
    );
    this.client.on(Events.Error, (e) => logger.error("client error", e));
  }

  async start(): Promise<void> {
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.client.destroy();
  }

  /** Exposed for tests, which construct the live parts around fakes. */
  attach(live: Live): void {
    this.live = live;
  }

  private fatal(message: string, e: unknown): void {
    logger.error(message, e);
    process.exit(1);
  }

  private async guard(what: string, fn: () => unknown): Promise<void> {
    if (!this.live) return;
    try {
      await fn();
    } catch (e) {
      logger.error(`${what} handler failed`, e);
    }
  }

  // Startup -----------------------------------------------------------------

  private async onReady(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const channel = await this.textChannel(guild, this.config.courtChannelId, "courtChannelId");
    const logChannel = await this.textChannel(guild, this.config.logChannelId, "logChannelId");
    const { policy, shadow } = this.config;

    const actions = new Actions({ guild, store: this.store, policy, shadow, now: this.now });
    const court = new Court({
      guild,
      channel,
      logChannel,
      store: this.store,
      engine: this.engine,
      actions,
      policy,
      shadow,
      now: this.now,
    });
    const drafts = new Drafts(this.now);
    this.attach({
      guild,
      court,
      actions,
      drafts,
      interactions: new Interactions({
        config: this.config,
        guild,
        store: this.store,
        engine: this.engine,
        court,
        drafts,
        now: this.now,
      }),
      mentions: new MentionFiling(this.client, drafts),
      noContact: new NoContactGuard({
        client: this.client,
        store: this.store,
        court,
        guildName: guild.name,
        shadow,
        now: this.now,
      }),
    });

    await fetchMembers(guild, this.store);
    this.resyncVoice(guild);
    await court.repostMissing();

    this.timer = setInterval(() => void this.tick(), TICK_MS);
    logger.info(`ready as ${this.client.user?.tag} in ${guild.name}; ${shadow ? "TRIAL RUN (shadow)" : "LIVE"}`);
    await this.tick();
  }

  private async textChannel(guild: Guild, id: string, what: string): Promise<GuildTextBasedChannel> {
    const channel = await guild.channels.fetch(id);
    const isVoice = channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
    if (!channel || !channel.isTextBased() || isVoice) {
      throw new Error(`${what} ${id} is not a text channel I can post in`);
    }
    return channel;
  }

  /** Forget what we thought was happening in voice while we were down, then record who is in voice now. */
  private resyncVoice(guild: Guild): void {
    this.store.tx(() => {
      this.store.voiceLeaveAll(this.now());
      for (const vs of guild.voiceStates.cache.values()) {
        if (vs.channelId && vs.member && !vs.member.user.bot) this.store.voiceJoin(vs.id, vs.channelId, this.now());
      }
    });
  }

  // The clock ---------------------------------------------------------------

  async tick(): Promise<void> {
    if (!this.live || this.ticking) return;
    this.ticking = true;
    try {
      await this.live.court.runDue();
      if (this.now() - this.lastPurge > PURGE_EVERY) {
        this.engine.purgeOldVoice();
        this.lastPurge = this.now();
      }
      this.live.drafts.sweep();
    } catch (e) {
      logger.error("tick failed", e);
    } finally {
      this.ticking = false;
    }
  }

  // Events ------------------------------------------------------------------

  private async onMessage(m: Message | PartialMessage): Promise<void> {
    if (m.partial || !m.inGuild() || m.guildId !== this.config.guildId || m.author.bot) return;
    if (await this.live!.noContact.onMessage(m)) return;
    await this.live!.mentions.onMessage(m);
  }

  private async onVoice(before: VoiceState, after: VoiceState): Promise<void> {
    if (after.guild.id !== this.config.guildId || after.member?.user.bot) return;
    if (before.channelId === after.channelId) return;
    if (after.channelId) {
      this.store.voiceJoin(after.id, after.channelId, this.now());
      await this.live!.noContact.onVoiceJoin(after);
    } else {
      this.store.voiceLeave(after.id, this.now());
    }
  }

  private async onMemberAdd(m: GuildMember): Promise<void> {
    if (m.guild.id !== this.config.guildId || m.user.bot) return;
    if (m.joinedTimestamp) this.store.seen(m.id, m.joinedTimestamp);
    await this.live!.actions.applyOwed(m);
  }
}
