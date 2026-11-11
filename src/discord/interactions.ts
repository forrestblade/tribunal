// Routes slash commands, context menus, buttons, modals and autocomplete to the engine.
import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type UserContextMenuCommandInteraction,
} from "discord.js";
import type { Config } from "../config.js";
import type { Engine, MemberInfo, Refusal, Result } from "../engine/engine.js";
import { mention } from "../format.js";
import { logger } from "../logger.js";
import type { Store } from "../store.js";
import type { CaseRecord, Evidence } from "../types.js";
import { COMMANDS, OPTIONS } from "./commands.js";
import type { Court } from "./court.js";
import { decodeCustomId, type MessageRef } from "./custom-ids.js";
import type { Drafts } from "./drafts.js";
import { fileForm, readFileForm, readStatementForm, statementForm } from "./forms.js";
import { evidenceFrom, fetchMembers, toMemberInfo } from "./members.js";
import { helpText, recordEmbed, statusText } from "./render.js";

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

/** Reply privately and stop. */
async function tell(i: RepliableInteraction, content: string): Promise<void> {
  await i.reply({ content, ...EPHEMERAL });
}
const AUTOCOMPLETE_MAX = 25;

type FilingInteraction = ChatInputCommandInteraction | ModalSubmitInteraction;
type FormOpener = UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction | ButtonInteraction;

interface SanctionRequest {
  stepId: string;
  reason: string;
  rule: string | null;
  voice: boolean | "auto";
  /** Resolved to Evidence only after the interaction is deferred, so a slow fetch cannot miss Discord's 3 s window. */
  evidence: MessageRef | null;
}

export interface InteractionsOptions {
  config: Config;
  guild: Guild;
  store: Store;
  engine: Engine;
  court: Court;
  drafts: Drafts;
  now?: () => number;
}

export class Interactions {
  private readonly config: Config;
  private readonly guild: Guild;
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly court: Court;
  private readonly drafts: Drafts;
  private readonly now: () => number;

  constructor(o: InteractionsOptions) {
    this.config = o.config;
    this.guild = o.guild;
    this.store = o.store;
    this.engine = o.engine;
    this.court = o.court;
    this.drafts = o.drafts;
    this.now = o.now ?? Date.now;
  }

  async handle(i: Interaction): Promise<void> {
    if (!i.inGuild() || i.guildId !== this.guild.id) return;
    try {
      if (i.isChatInputCommand()) await this.onSlash(i);
      else if (i.isUserContextMenuCommand()) await this.openFileForm(i, i.targetId, null, "");
      else if (i.isMessageContextMenuCommand()) await this.onMessageMenu(i);
      else if (i.isButton()) await this.onButton(i);
      else if (i.isModalSubmit()) await this.onModal(i);
      else if (i.isAutocomplete()) await this.onAutocomplete(i);
    } catch (e) {
      logger.error(`interaction ${i.id} failed`, e);
      if (i.isRepliable()) await this.apologise(i);
    }
  }

  private async apologise(i: RepliableInteraction): Promise<void> {
    const payload = { content: "Something went wrong on my end. It's been logged.", ...EPHEMERAL };
    try {
      if (i.deferred || i.replied) await i.followUp(payload);
      else await i.reply(payload);
    } catch {
      /* the interaction has expired; nothing more to do */
    }
  }

  // Slash commands ----------------------------------------------------------

  private async onSlash(i: ChatInputCommandInteraction): Promise<void> {
    switch (i.commandName) {
      case COMMANDS.case:
        return this.fileSanction(i, i.options.getUser(OPTIONS.who, true).id, {
          stepId: i.options.getString(OPTIONS.punishment, true),
          reason: i.options.getString(OPTIONS.reason, true),
          rule: i.options.getString(OPTIONS.rule),
          voice: i.options.getBoolean(OPTIONS.voice) ?? "auto",
          evidence: null,
        });
      case COMMANDS.nocontact:
        return this.file(i, (members, proposer) => {
          const a = members.find((m) => m.id === i.options.getUser(OPTIONS.first, true).id);
          const b = members.find((m) => m.id === i.options.getUser(OPTIONS.second, true).id);
          if (!a || !b) return { ok: false, reason: "Both people need to be in the server." };
          return this.engine.fileNoContact({
            proposer,
            a,
            b,
            reason: i.options.getString(OPTIONS.reason, true),
            members,
          });
        });
      case COMMANDS.appeal:
        return this.file(i, (members, proposer) => {
          const userId = i.options.getString(OPTIONS.who, true).replace(/\D/g, "");
          if (!userId) return { ok: false, reason: "Pick someone from the list." };
          return this.engine.fileAppeal({
            proposer,
            userId,
            reason: i.options.getString(OPTIONS.reason, true),
            members,
          });
        });
      case COMMANDS.record:
        return this.record(i);
      case COMMANDS.status:
        return this.status(i);
      case COMMANDS.help:
        return tell(i, helpText(this.config.policy, this.config.rules, this.config.shadow));
      default:
        logger.warn(`unknown command ${i.commandName}`);
    }
  }

  private async record(i: ChatInputCommandInteraction): Promise<void> {
    const user = i.options.getUser(OPTIONS.who) ?? i.user;
    const member = await this.guild.members.fetch(user.id).catch(() => null);
    const info = member ? toMemberInfo(member) : null;
    const embed = recordEmbed(
      `Record for ${member?.displayName ?? user.username}`,
      this.engine.record(user.id, info),
      info,
      info ? this.engine.memberAgeDays(info) : null,
      info ? this.engine.isMember(info) : false,
      this.config.policy,
      this.now(),
    );
    await i.reply({ embeds: [embed], ...EPHEMERAL });
  }

  private async status(i: ChatInputCommandInteraction): Promise<void> {
    const open = this.store.openCases().map((c) => ({ case: c, tally: this.engine.tally(c) }));
    const text = statusText(
      open,
      this.engine.breakerPausedUntil(),
      this.config.shadow,
      this.config.policy,
      this.guild.id,
    );
    await i.reply({ content: text, ...EPHEMERAL, allowedMentions: { parse: [] } });
  }

  private async onAutocomplete(i: AutocompleteInteraction): Promise<void> {
    if (i.commandName !== COMMANDS.appeal) return i.respond([]);
    const typed = i.options.getFocused().toLowerCase();
    const choices: { name: string; value: string }[] = [];
    for (const ban of this.engine.appealable().slice(0, AUTOCOMPLETE_MAX)) {
      const name = await this.guild.client.users
        .fetch(ban.userId)
        .then((u) => u.username)
        .catch(() => ban.userId);
      const until = ban.until === null ? "permanent" : `until ${new Date(ban.until).toISOString().slice(0, 10)}`;
      const label = `${name} (case #${ban.caseId}, ${until})`;
      if (!typed || label.toLowerCase().includes(typed)) choices.push({ name: label.slice(0, 100), value: ban.userId });
    }
    await i.respond(choices);
  }

  // Context menus, buttons and modals ---------------------------------------

  private async onMessageMenu(i: MessageContextMenuCommandInteraction): Promise<void> {
    const m = i.targetMessage;
    if (m.author.bot) return tell(i, "That's a bot's message.");
    await this.openFileForm(i, m.author.id, this.drafts.keepEvidence(evidenceFrom(m)), "");
  }

  private async onButton(i: ButtonInteraction): Promise<void> {
    const id = decodeCustomId(i.customId);
    switch (id?.kind) {
      case "vote":
        return this.vote(i, id.caseId, id.value);
      case "statement": {
        const c = this.store.getCase(id.caseId);
        if (!c || !this.engine.canMakeStatement(c, i.user.id)) {
          return tell(i, "Only the people the case is about can post a statement while it's open.");
        }
        return i.showModal(statementForm(c.id));
      }
      case "open": {
        const draft = this.drafts.reasons.get(i.message.id);
        if (draft && draft.authorId !== i.user.id) {
          return tell(
            i,
            `That button is for ${mention(draft.authorId)}. Use /case or right-click the person to file your own.`,
          );
        }
        await this.openFileForm(i, id.targetId, id.evidence, draft?.reason ?? "");
        this.drafts.reasons.delete(i.message.id);
        await i.message.delete().catch(() => undefined);
        return;
      }
      default:
        return tell(i, "I don't know that button any more.");
    }
  }

  private async onModal(i: ModalSubmitInteraction): Promise<void> {
    const id = decodeCustomId(i.customId);
    switch (id?.kind) {
      case "statement": {
        const c = this.store.getCase(id.caseId);
        if (!c || !this.engine.canMakeStatement(c, i.user.id)) return tell(i, "That case has closed.");
        this.store.setStatement(c.id, i.user.id, readStatementForm(i), this.now());
        await tell(i, "Your statement is on the card.");
        return this.court.refresh(c.id);
      }
      case "file":
        return this.fileSanction(i, id.targetId, { ...readFileForm(i), evidence: id.evidence });
      default:
        return tell(i, "I don't know that form any more.");
    }
  }

  private async vote(i: ButtonInteraction, caseId: number, value: "yes" | "no"): Promise<void> {
    const r = this.engine.vote(caseId, i.user.id, value);
    if (!r.ok) return tell(i, r.reason);
    const { case: c, previous, settled } = r.value;
    const turnout = this.engine.tally(c).votes.length;
    const content =
      previous && previous !== value
        ? `Changed your vote to **${value}**.`
        : `Recorded **${value}**. ${turnout} of ${c.electorate.length} have voted. You can change it until the case closes.`;
    await i.reply({ content, ...EPHEMERAL });
    if (settled) await this.court.settle(settled);
    else await this.court.refresh(c.id);
  }

  // Filing ------------------------------------------------------------------

  private async openFileForm(
    i: FormOpener,
    targetId: string,
    evidence: MessageRef | null,
    draftReason: string,
  ): Promise<void> {
    const target = await this.guild.members.fetch(targetId).catch(() => null);
    if (!target) return tell(i, "They're not in the server.");
    if (target.user.bot) return tell(i, "Bots can't be put on trial.");
    await i.showModal(
      fileForm({
        targetId,
        targetName: target.displayName,
        targetInVoice: target.voice.channelId !== null,
        steps: this.engine.allowedSteps(toMemberInfo(target)),
        rules: this.config.rules,
        evidence,
        draftReason,
      }),
    );
  }

  private async fileSanction(i: FilingInteraction, targetId: string, request: SanctionRequest): Promise<void> {
    await this.file(i, async (members, proposer) => {
      const target = members.find((m) => m.id === targetId);
      if (!target) return { ok: false, reason: "They're not in the server." };
      const evidence = request.evidence ? await this.resolveEvidence(request.evidence) : null;
      return this.engine.fileSanction({ proposer, target, ...request, evidence, members });
    });
  }

  /** The shape every filing shares: defer, fetch members, run the engine, post the card, answer. */
  private async file(
    i: FilingInteraction,
    attempt: (members: MemberInfo[], proposer: MemberInfo) => Result<CaseRecord> | Promise<Result<CaseRecord>>,
  ): Promise<void> {
    await i.deferReply(EPHEMERAL);
    const members = await fetchMembers(this.guild, this.store);
    const proposer = members.find((m) => m.id === i.user.id);
    const result: Result<CaseRecord> = proposer
      ? await attempt(members, proposer)
      : { ok: false, reason: "I can't find you in the member list." };
    if (!result.ok) return this.refused(i, result);
    const posted = await this.court.open(result.value);
    await i.editReply(`Filed case #${posted.id}. ${this.court.link(posted)}`);
  }

  private async refused(i: FilingInteraction, r: Refusal): Promise<void> {
    if (r.breakerTripped) await this.court.log(`Brake: ${r.reason}`);
    await i.editReply(r.reason);
  }

  /** Evidence kept from a right-click, or fetched by id; falls back to a bare link if the message is gone. */
  private async resolveEvidence(ref: MessageRef): Promise<Evidence> {
    const kept = this.drafts.takeEvidence(ref);
    if (kept) return kept;
    try {
      const channel = await this.guild.channels.fetch(ref.channelId);
      if (channel?.isTextBased()) return evidenceFrom(await channel.messages.fetch(ref.messageId));
    } catch {
      /* deleted, or a channel the bot cannot read */
    }
    return {
      ...ref,
      url: `https://discord.com/channels/${this.guild.id}/${ref.channelId}/${ref.messageId}`,
      authorId: null,
      content: null,
      attachments: [],
    };
  }
}
