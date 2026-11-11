import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type PartialMessage,
  type UserContextMenuCommandInteraction,
  type VoiceState,
} from "discord.js";
import type { Config } from "../config.js";
import { Engine, type MemberInfo, type Settled } from "../engine/engine.js";
import { stepLabel } from "../policy.js";
import type { Store } from "../store.js";
import type { CaseRecord, Evidence } from "../types.js";
import { applyEffect, applyPendingTimeouts } from "./actions.js";
import { COMMANDS } from "./commands.js";
import { allMembers, toMemberInfo } from "./members.js";
import { closedCard, helpText, logLine, openCard } from "./render.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

export class Bot {
  readonly client: Client;
  private guild!: Guild;
  private court!: GuildTextBasedChannel;
  private logChannel!: GuildTextBasedChannel;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Reason text from "@bot @user words", waiting for the author to open the form. */
  private draftReasons = new Map<string, { authorId: string; reason: string; at: number }>();
  private lastNoContactNote = new Map<string, number>();
  /** Evidence copied from a right-clicked message, keyed by channel:message, until its form is submitted. */
  private evidenceCache = new Map<string, { evidence: Evidence; at: number }>();
  private lastPurge = 0;

  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly engine: Engine,
    readonly now: () => number = Date.now,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration],
    });
    this.client.once(Events.ClientReady, () => void this.onReady().catch((e) => this.fatal(e)));
    this.client.on(Events.InteractionCreate, (i) => void this.safely(() => this.onInteraction(i), i));
    this.client.on(Events.MessageCreate, (m) => void this.safely(() => this.onMessage(m)));
    this.client.on(Events.VoiceStateUpdate, (a, b) => void this.safely(() => this.onVoice(a, b)));
    this.client.on(Events.GuildMemberAdd, (m) => void this.safely(() => this.onMemberAdd(m)));
    this.client.on(Events.GuildBanRemove, (b) => void this.safely(async () => this.engine.banLiftedElsewhere(b.user.id)));
    this.client.on(Events.Error, (e) => log("client error", e));
  }

  async start() {
    await this.client.login(this.config.token);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.client.destroy();
  }

  private fatal(e: unknown) {
    console.error("fatal", e);
    process.exit(1);
  }

  private async safely(fn: () => Promise<unknown>, i?: Interaction) {
    try {
      await fn();
    } catch (e) {
      log("handler error", e);
      if (i && (i.isRepliable() || i.isModalSubmit())) {
        const payload = { content: "Something went wrong on my end. It's been logged.", ...EPHEMERAL };
        try {
          if (i.deferred || i.replied) await i.followUp(payload);
          else await i.reply(payload);
        } catch {
          /* nothing more to do */
        }
      }
    }
  }

  // Startup -----------------------------------------------------------------

  private async onReady() {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    this.guild = guild;
    this.court = await this.textChannel(this.config.courtChannelId, "courtChannelId");
    this.logChannel = await this.textChannel(this.config.logChannelId, "logChannelId");
    await allMembers(guild, this.store);

    // Voice: forget what we thought was happening while we were down, then record who is in voice now.
    this.store.tx(() => {
      this.store.voiceLeaveAll(this.now());
      for (const vs of guild.voiceStates.cache.values()) if (vs.channelId && vs.member && !vs.member.user.bot) this.store.voiceJoin(vs.id, vs.channelId, this.now());
    });

    // Cards that never got posted because we crashed in between.
    for (const c of this.store.openCases()) if (!c.messageId) await this.postCase(c);

    this.timer = setInterval(() => void this.tick(), 15_000);
    log(`ready as ${this.client.user?.tag} in ${guild.name}; ${this.config.shadow ? "TRIAL RUN (shadow)" : "LIVE"}`);
    await this.tick();
  }

  private async textChannel(id: string, what: string): Promise<GuildTextBasedChannel> {
    const ch = await this.guild.channels.fetch(id);
    if (!ch || !ch.isTextBased() || ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) throw new Error(`${what} ${id} is not a text channel I can post in`);
    return ch;
  }

  // The clock --------------------------------------------------------------

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const s of this.engine.closeDue()) await this.finish(s).catch((e) => log("finish error", e));
      for (const job of this.store.dueScheduled(this.now())) {
        if (!this.store.finishScheduled(job.id, this.now())) continue;
        if (job.kind === "unban") {
          const ban = this.store.activeBan(job.userId, this.config.shadow);
          if (!ban || ban.caseId !== job.caseId) continue;
          this.store.liftBan(job.userId, this.now());
          const c = this.store.getCase(job.caseId)!;
          const { notes } = await applyEffect({ type: "unban", userId: job.userId }, c, this.guild, this.store, this.config.policy, this.config.shadow, this.now);
          await this.log(`Case #${job.caseId}: ${this.config.shadow ? "would have lifted" : "lifted"} <@${job.userId}>'s ban, time served.${notes.length ? ` ${notes.join(" ")}` : ""}`);
        }
      }
      if (this.now() - this.lastPurge > DAY) {
        this.engine.purgeOldVoice();
        this.lastPurge = this.now();
      }
      for (const [k, v] of this.draftReasons) if (this.now() - v.at > 15 * MIN) this.draftReasons.delete(k);
      for (const [k, v] of this.evidenceCache) if (this.now() - v.at > 15 * MIN) this.evidenceCache.delete(k);
    } catch (e) {
      log("tick error", e);
    } finally {
      this.ticking = false;
    }
  }

  // Interactions -------------------------------------------------------------

  private async onInteraction(i: Interaction) {
    if (!i.inGuild() || i.guildId !== this.config.guildId) return;
    if (i.isChatInputCommand()) return this.onSlash(i);
    if (i.isUserContextMenuCommand()) return this.showFileModal(i, i.targetId, null, "");
    if (i.isMessageContextMenuCommand()) return this.onMessageMenu(i);
    if (i.isButton()) return this.onButton(i);
    if (i.isModalSubmit()) return this.onModal(i);
    if (i.isAutocomplete()) return this.onAutocomplete(i);
  }

  private async onSlash(i: ChatInputCommandInteraction) {
    switch (i.commandName) {
      case COMMANDS.case: {
        await i.deferReply(EPHEMERAL);
        return this.file(i, i.options.getUser("who", true).id, {
          stepId: i.options.getString("punishment", true),
          reason: i.options.getString("reason", true),
          rule: i.options.getString("rule"),
          voice: i.options.getBoolean("voice") ?? "auto",
          evidence: null,
        });
      }
      case COMMANDS.nocontact: {
        await i.deferReply(EPHEMERAL);
        const members = await allMembers(this.guild, this.store);
        const find = (id: string) => members.find((m) => m.id === id);
        const proposer = find(i.user.id);
        const a = find(i.options.getUser("first", true).id);
        const b = find(i.options.getUser("second", true).id);
        if (!proposer || !a || !b) return i.editReply("Both people need to be in the server.");
        const r = this.engine.fileNoContact({ proposer, a, b, reason: i.options.getString("reason", true), members });
        if (!r.ok) return this.refused(i, r);
        await this.postCase(r.value);
        return i.editReply(`Filed case #${r.value.id}. ${this.cardLink(r.value)}`);
      }
      case COMMANDS.appeal: {
        await i.deferReply(EPHEMERAL);
        const members = await allMembers(this.guild, this.store);
        const proposer = members.find((m) => m.id === i.user.id);
        if (!proposer) return i.editReply("I can't find you in the member list.");
        const userId = i.options.getString("who", true).replace(/\D/g, "");
        if (!userId) return i.editReply("Pick someone from the list.");
        const r = this.engine.fileAppeal({ proposer, userId, reason: i.options.getString("reason", true), members });
        if (!r.ok) return this.refused(i, r);
        await this.postCase(r.value);
        return i.editReply(`Filed case #${r.value.id}. ${this.cardLink(r.value)}`);
      }
      case COMMANDS.record:
        return this.record(i);
      case COMMANDS.status:
        return this.status(i);
      case COMMANDS.help:
        return i.reply({ content: helpText(this.config.policy, this.config.rules, this.config.shadow), ...EPHEMERAL });
    }
  }

  private async onMessageMenu(i: MessageContextMenuCommandInteraction) {
    const m = i.targetMessage;
    if (m.author.bot) return i.reply({ content: "That's a bot's message.", ...EPHEMERAL });
    const evidence: Evidence = {
      url: m.url,
      authorId: m.author.id,
      content: m.content || null,
      attachments: m.attachments.map((a) => ({ name: a.name, url: a.url, size: a.size })),
    };
    return this.showFileModal(i, m.author.id, evidence, "");
  }

  private async onAutocomplete(i: AutocompleteInteraction) {
    if (i.commandName !== COMMANDS.appeal) return i.respond([]);
    const typed = i.options.getFocused().toLowerCase();
    const out: { name: string; value: string }[] = [];
    for (const b of this.engine.appealable().slice(0, 25)) {
      const name = await this.client.users.fetch(b.userId).then((u) => u.username).catch(() => b.userId);
      const label = `${name} (case #${b.caseId}, ${b.until === null ? "permanent" : `until ${new Date(b.until).toISOString().slice(0, 10)}`})`;
      if (!typed || label.toLowerCase().includes(typed)) out.push({ name: label.slice(0, 100), value: b.userId });
    }
    return i.respond(out);
  }

  private async onButton(i: ButtonInteraction) {
    const [kind, a, b, c4] = i.customId.split(":");
    if (kind === "vote" && a && (b === "yes" || b === "no")) {
      const r = this.engine.vote(Number(a), i.user.id, b);
      if (!r.ok) return i.reply({ content: r.reason, ...EPHEMERAL });
      const { case: c, previous, settled } = r.value;
      const t = this.engine.tally(c);
      await i.reply({
        content: previous && previous !== b ? `Changed your vote to **${b}**.` : `Recorded **${b}**. ${t.votes.length} of ${c.electorate.length} have voted. You can change it until the case closes.`,
        ...EPHEMERAL,
      });
      if (settled) return this.finish(settled);
      return this.refreshCard(c);
    }
    if (kind === "stmt" && a) {
      const c = this.store.getCase(Number(a));
      if (!c || !this.engine.canMakeStatement(c, i.user.id)) return i.reply({ content: "Only the people the case is about can post a statement while it's open.", ...EPHEMERAL });
      const modal = new ModalBuilder()
        .setCustomId(`stmt:${c.id}`)
        .setTitle(`Statement on case #${c.id}`)
        .addLabelComponents(
          new LabelBuilder()
            .setLabel("Your side")
            .setDescription("Shown on the case card to everyone voting.")
            .setTextInputComponent(new TextInputBuilder().setCustomId("text").setStyle(TextInputStyle.Paragraph).setMaxLength(900).setRequired(true)),
        );
      return i.showModal(modal);
    }
    if (kind === "open" && a) {
      const draft = this.draftReasons.get(i.message.id);
      if (draft && draft.authorId !== i.user.id) return i.reply({ content: `That button is for <@${draft.authorId}>. Use /case or right-click the person to file your own.`, ...EPHEMERAL });
      const evidence = b && b !== "-" && c4 && c4 !== "-" ? await this.evidenceFromIds(b, c4) : null;
      await this.showFileModal(i, a, evidence, draft?.reason ?? "");
      this.draftReasons.delete(i.message.id);
      await i.message.delete().catch(() => undefined);
      return;
    }
    return i.reply({ content: "I don't know that button any more.", ...EPHEMERAL });
  }

  private async onModal(i: ModalSubmitInteraction) {
    const [kind, a, chan, msg] = i.customId.split(":");
    if (kind === "stmt" && a) {
      const c = this.store.getCase(Number(a));
      if (!c || !this.engine.canMakeStatement(c, i.user.id)) return i.reply({ content: "That case has closed.", ...EPHEMERAL });
      this.store.setStatement(c.id, i.user.id, i.fields.getTextInputValue("text").trim(), this.now());
      await i.reply({ content: "Your statement is on the card.", ...EPHEMERAL });
      return this.refreshCard(c);
    }
    if (kind === "file" && a) {
      await i.deferReply(EPHEMERAL);
      const evidence = chan && chan !== "-" && msg && msg !== "-" ? await this.evidenceFromIds(chan, msg) : null;
      const where = i.fields.getStringSelectValues("where")[0];
      return this.file(i, a, {
        stepId: i.fields.getStringSelectValues("punishment")[0] ?? "",
        reason: i.fields.getTextInputValue("reason").trim(),
        rule: this.optionalSelect(i, "rule"),
        voice: where === "voice" ? true : where === "text" ? false : "auto",
        evidence,
      });
    }
    return i.reply({ content: "I don't know that form any more.", ...EPHEMERAL });
  }

  // Filing -----------------------------------------------------------------

  private async showFileModal(i: UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction | ButtonInteraction, targetId: string, evidence: Evidence | null, draftReason: string) {
    const target = await this.guild.members.fetch(targetId).catch(() => null);
    if (!target) return i.reply({ content: "They're not in the server.", ...EPHEMERAL });
    if (target.user.bot) return i.reply({ content: "Bots can't be put on trial.", ...EPHEMERAL });
    const steps = this.engine.allowedSteps(toMemberInfo(target));
    const chan = evidence?.url ? evidence.url.split("/").at(-2) ?? "-" : "-";
    const msg = evidence?.url ? evidence.url.split("/").at(-1) ?? "-" : "-";
    if (evidence) this.evidenceCache.set(`${chan}:${msg}`, { evidence, at: this.now() });
    const inVoice = target.voice.channelId !== null;
    const modal = new ModalBuilder()
      .setCustomId(`file:${targetId}:${chan}:${msg}`)
      .setTitle(`Case against ${target.displayName}`.slice(0, 45))
      .addLabelComponents(
        new LabelBuilder()
          .setLabel("Punishment")
          .setDescription("Only the steps allowed for them right now are listed.")
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder().setCustomId("punishment").setRequired(true).addOptions(steps.map((s) => new StringSelectMenuOptionBuilder().setLabel(s.label).setValue(s.id))),
          ),
        new LabelBuilder()
          .setLabel("Rule")
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId("rule")
              .setRequired(false)
              .addOptions([...this.config.rules.slice(0, 24), "Other"].map((r) => new StringSelectMenuOptionBuilder().setLabel(r).setValue(r))),
          ),
        new LabelBuilder()
          .setLabel("Where did it happen?")
          .setDescription("Voice cases need yes votes from people who were in the channel.")
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId("where")
              .setRequired(true)
              .addOptions(
                new StringSelectMenuOptionBuilder().setLabel("In voice chat").setValue("voice").setDefault(inVoice),
                new StringSelectMenuOptionBuilder().setLabel("In text").setValue("text").setDefault(!inVoice),
              ),
          ),
        new LabelBuilder()
          .setLabel("What happened")
          .setTextInputComponent(new TextInputBuilder().setCustomId("reason").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true).setValue(draftReason.slice(0, 500))),
      );
    return i.showModal(modal);
  }

  private optionalSelect(i: ModalSubmitInteraction, id: string): string | null {
    try {
      return i.fields.getStringSelectValues(id)[0] ?? null;
    } catch {
      return null;
    }
  }

  private async file(
    i: ChatInputCommandInteraction | ModalSubmitInteraction,
    targetId: string,
    input: { stepId: string; reason: string; rule: string | null; voice: boolean | "auto"; evidence: Evidence | null },
  ) {
    const members = await allMembers(this.guild, this.store);
    const proposer = members.find((m) => m.id === i.user.id);
    const target = members.find((m) => m.id === targetId);
    if (!proposer) return i.editReply("I can't find you in the member list.");
    if (!target) return i.editReply("They're not in the server.");
    const r = this.engine.fileSanction({ proposer, target, ...input, members });
    if (!r.ok) return this.refused(i, r);
    await this.postCase(r.value);
    return i.editReply(`Filed case #${r.value.id}. ${this.cardLink(r.value)}`);
  }

  private async refused(i: ChatInputCommandInteraction | ModalSubmitInteraction, r: { reason: string; breakerTripped?: boolean }) {
    if (r.breakerTripped) await this.log(`Brake: ${r.reason}`);
    return i.editReply(r.reason);
  }

  private async evidenceFromIds(channelId: string, messageId: string): Promise<Evidence | null> {
    const cached = this.evidenceCache.get(`${channelId}:${messageId}`);
    if (cached) {
      this.evidenceCache.delete(`${channelId}:${messageId}`);
      return cached.evidence;
    }
    try {
      const ch = await this.guild.channels.fetch(channelId);
      if (!ch || !ch.isTextBased()) return null;
      const m = await ch.messages.fetch(messageId);
      return { url: m.url, authorId: m.author.id, content: m.content || null, attachments: m.attachments.map((a) => ({ name: a.name, url: a.url, size: a.size })) };
    } catch {
      return { url: `https://discord.com/channels/${this.config.guildId}/${channelId}/${messageId}`, authorId: null, content: null, attachments: [] };
    }
  }

  // Cards -----------------------------------------------------------------

  private cardLink(c: CaseRecord): string {
    return c.messageId ? `https://discord.com/channels/${this.config.guildId}/${c.channelId}/${c.messageId}` : `See <#${this.config.courtChannelId}>.`;
  }

  private async postCase(c: CaseRecord) {
    const msg = await this.court.send({ content: `<@${c.targetId}>${c.partyBId ? ` <@${c.partyBId}>` : ""}`, ...openCard(c, this.config.policy, this.engine.tally(c), this.store.statements(c.id)) });
    this.store.setCaseMessage(c.id, msg.channelId, msg.id, null);
    c.channelId = msg.channelId;
    c.messageId = msg.id;
  }

  private async refreshCard(c: CaseRecord) {
    const fresh = this.store.getCase(c.id) ?? c;
    if (!fresh.messageId || fresh.status !== "open") return;
    const msg = await this.court.messages.fetch(fresh.messageId).catch(() => null);
    if (msg) await msg.edit(openCard(fresh, this.config.policy, this.engine.tally(fresh), this.store.statements(fresh.id)));
  }

  private async finish(s: Settled) {
    const c = s.case;
    const notes: string[] = [];
    for (const e of s.effects) {
      try {
        const r = await applyEffect(e, c, this.guild, this.store, this.config.policy, this.config.shadow, this.now);
        notes.push(...r.notes);
      } catch (err) {
        log("effect error", err);
        notes.push(`Could not apply ${e.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const tally = this.engine.tally(c);
    const card = closedCard(c, this.config.policy, tally, this.store.statements(c.id), s.effects, notes);
    if (c.messageId) {
      const msg = await this.court.messages.fetch(c.messageId).catch(() => null);
      if (msg) await msg.edit(card);
      else await this.court.send(card);
    } else {
      await this.court.send(card);
    }
    await this.log(logLine(c, this.config.policy, tally, s.effects, notes));
  }

  private async log(text: string) {
    log(text.replace(/<@(\d+)>/g, "@$1"));
    await this.logChannel.send({ content: text, allowedMentions: { parse: [] } }).catch((e) => log("could not write to log channel", e));
  }

  // Messages: "@bot @user why" and no-contact enforcement ----------------------

  private async onMessage(m: Message | PartialMessage) {
    if (m.partial || !m.inGuild() || m.guildId !== this.config.guildId || m.author.bot) return;
    if (await this.enforceNoContactMessage(m)) return;
    if (!this.client.user || !m.mentions.has(this.client.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) return;
    const target = m.mentions.users.find((u) => u.id !== this.client.user?.id && !u.bot && u.id !== m.mentions.repliedUser?.id) ?? (m.mentions.repliedUser && !m.mentions.repliedUser.bot ? m.mentions.repliedUser : null);
    if (!target) {
      await m.reply({ content: "Tag the person too, like `@me @them what they did`, or use /case.", allowedMentions: { parse: [] } });
      return;
    }
    const reason = m.content.replace(/<@!?\d+>/g, "").trim();
    const ref = m.reference?.messageId && m.reference.channelId ? `${m.reference.channelId}:${m.reference.messageId}` : "-:-";
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`open:${target.id}:${ref}`).setLabel(`Open the form against ${target.displayName}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
    );
    const reply = await m.reply({ content: `<@${m.author.id}>, press the button to pick the punishment and file it.`, components: [row], allowedMentions: { users: [m.author.id] } });
    this.draftReasons.set(reply.id, { authorId: m.author.id, reason, at: this.now() });
  }

  private async enforceNoContactMessage(m: Message<true>): Promise<boolean> {
    const orders = this.store.activeNoContacts(this.now(), this.config.shadow).filter((o) => o.aId === m.author.id || o.bId === m.author.id);
    for (const o of orders) {
      const other = o.aId === m.author.id ? o.bId : o.aId;
      const touches = m.mentions.users.has(other) || m.mentions.repliedUser?.id === other;
      if (!touches) continue;
      if (this.config.shadow) {
        await this.log(`No-contact (trial run): would have removed a message from <@${m.author.id}> that mentioned or replied to <@${other}> (case #${o.caseId}).`);
      } else {
        await m.delete().catch(() => undefined);
        await this.log(`No-contact: removed a message from <@${m.author.id}> that mentioned or replied to <@${other}> (case #${o.caseId}).`);
      }
      await this.noteNoContact(m.author.id, other, o.until, "messages that mention or reply to");
      return !this.config.shadow;
    }
    return false;
  }

  private async noteNoContact(userId: string, other: string, until: number, what: string) {
    const key = `${userId}:${other}`;
    if (this.now() - (this.lastNoContactNote.get(key) ?? 0) < 10 * MIN) return;
    this.lastNoContactNote.set(key, this.now());
    const u = await this.client.users.fetch(userId).catch(() => null);
    await u?.send(`Reminder from **${this.guild.name}**: you're under a no-contact order with <@${other}> until <t:${Math.floor(until / 1000)}:f>. The bot ${this.config.shadow ? "will remove" : "removes"} ${what} them.`).catch(() => undefined);
  }

  // Voice ---------------------------------------------------------------------

  private async onVoice(before: VoiceState, after: VoiceState) {
    if (after.guild.id !== this.config.guildId || after.member?.user.bot) return;
    if (before.channelId === after.channelId) return;
    if (after.channelId) this.store.voiceJoin(after.id, after.channelId, this.now());
    else this.store.voiceLeave(after.id, this.now());
    if (!after.channelId) return;

    const orders = this.store.activeNoContacts(this.now(), this.config.shadow).filter((o) => o.aId === after.id || o.bId === after.id);
    for (const o of orders) {
      const other = o.aId === after.id ? o.bId : o.aId;
      const otherState = after.guild.voiceStates.cache.get(other);
      if (otherState?.channelId !== after.channelId) continue;
      if (this.config.shadow) {
        await this.log(`No-contact (trial run): would have moved <@${after.id}> out of <#${after.channelId}> because <@${other}> is there (case #${o.caseId}).`);
      } else {
        await after.disconnect(`Tribunal no-contact order, case #${o.caseId}`).catch(() => undefined);
        await this.log(`No-contact: moved <@${after.id}> out of <#${after.channelId}> because <@${other}> was there (case #${o.caseId}).`);
      }
      await this.noteNoContact(after.id, other, o.until, "you from voice channels shared with");
    }
  }

  private async onMemberAdd(m: GuildMember) {
    if (m.guild.id !== this.config.guildId || m.user.bot) return;
    if (m.joinedTimestamp) this.store.seen(m.id, m.joinedTimestamp);
    if (!this.config.shadow) await applyPendingTimeouts(m, this.store);
  }

  // Read-only commands ------------------------------------------------------------

  private async record(i: ChatInputCommandInteraction) {
    const user = i.options.getUser("who") ?? i.user;
    const member = await this.guild.members.fetch(user.id).catch(() => null);
    const info: MemberInfo | null = member ? toMemberInfo(member) : null;
    const level = this.engine.level(user.id);
    const strikes = this.store.strikes(user.id, this.config.shadow);
    const lines = strikes.map((s) => {
      const c = this.store.getCase(s.caseId);
      const ends = s.endsAt === null ? "permanent" : s.endsAt > this.now() ? `ends <t:${Math.floor(s.endsAt / 1000)}:R>` : `ended <t:${Math.floor(s.endsAt / 1000)}:D>`;
      return `• Case #${s.caseId}: ${c?.stepId ? stepLabel(this.config.policy, c.stepId) : `level ${s.level}`}, ${ends}`;
    });
    const ban = this.store.activeBan(user.id, this.config.shadow);
    const embed = new EmbedBuilder()
      .setTitle(`Record for ${member?.displayName ?? user.username}`)
      .setDescription(
        [
          `Level **${level}** (${this.engine.allowedSteps(info ?? { id: user.id, name: user.username, isBot: false, immune: false, joinedAt: null, timedOutUntil: null, voiceChannelId: null }).filter((s) => s.level !== null).map((s) => s.label).join(", ") || "nothing"} can be proposed).`,
          info ? `${info.immune ? "Immune (owner, admin, or above the bot)." : `${this.engine.isMember(info) ? "Member" : "Newcomer"}, ${Math.floor(this.engine.memberAgeDays(info))} days here.`}` : "Not in the server.",
          ban ? `Banned by case #${ban.caseId}${ban.until ? `, until <t:${Math.floor(ban.until / 1000)}:f>` : ", permanently"}.` : "",
          lines.length ? `\n**Strikes (last ${this.config.policy.strikeWindowDays} days):**\n${lines.join("\n")}` : "\nNo strikes.",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setColor(0x5865f2);
    return i.reply({ embeds: [embed], ...EPHEMERAL });
  }

  private async status(i: ChatInputCommandInteraction) {
    const open = this.store.openCases();
    const paused = this.engine.breakerPausedUntil();
    const lines = open.map((c) => {
      const t = this.engine.tally(c);
      return `• [Case #${c.id}](${this.cardLink(c)}): ${c.kind === "sanction" ? stepLabel(this.config.policy, c.stepId ?? "") : c.kind} on <@${c.targetId}>${c.partyBId ? ` and <@${c.partyBId}>` : ""}, ${t.votes.length}/${c.electorate.length} voted, closes <t:${Math.floor(c.closesAt / 1000)}:R>`;
    });
    const text = [
      this.config.shadow ? "**Trial run.** Votes count, punishments are not applied." : "**Live.**",
      paused ? `Filing is paused until <t:${Math.floor(paused / 1000)}:t>.` : "Filing is open.",
      lines.length ? lines.join("\n") : "No open cases.",
    ].join("\n");
    return i.reply({ content: text, ...EPHEMERAL, allowedMentions: { parse: [] } });
  }
}
