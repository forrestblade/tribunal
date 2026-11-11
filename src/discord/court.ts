// The court channel and the log channel: posting cards, keeping them current,
// closing them, and the clock duties (deadlines, due unbans).
import type { Guild, GuildTextBasedChannel } from "discord.js";
import type { Engine, Settled } from "../engine/engine.js";
import { channelMention, mention } from "../format.js";
import { logger } from "../logger.js";
import type { Policy } from "../policy.js";
import type { Store } from "../store.js";
import type { CaseRecord } from "../types.js";
import type { Actions } from "./actions.js";
import { caseLink, closedCard, logLine, openCard, unbanLogLine } from "./render.js";

export interface CourtOptions {
  guild: Guild;
  channel: GuildTextBasedChannel;
  logChannel: GuildTextBasedChannel;
  store: Store;
  engine: Engine;
  actions: Actions;
  policy: Policy;
  shadow: boolean;
  now?: () => number;
}

export class Court {
  private readonly guild: Guild;
  private readonly channel: GuildTextBasedChannel;
  private readonly logChannel: GuildTextBasedChannel;
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly actions: Actions;
  private readonly policy: Policy;
  private readonly shadow: boolean;
  private readonly now: () => number;

  constructor(o: CourtOptions) {
    this.guild = o.guild;
    this.channel = o.channel;
    this.logChannel = o.logChannel;
    this.store = o.store;
    this.engine = o.engine;
    this.actions = o.actions;
    this.policy = o.policy;
    this.shadow = o.shadow;
    this.now = o.now ?? Date.now;
  }

  /** Post the vote card for a new case. Returns the case with its message ids filled in. */
  async open(c: CaseRecord): Promise<CaseRecord> {
    const pings = [c.targetId, c.partyBId].filter((id): id is string => id !== null);
    const message = await this.channel.send({
      content: pings.map(mention).join(" "),
      ...openCard(c, this.policy, this.engine.tally(c), this.store.statements(c.id)),
    });
    this.store.setCaseMessage(c.id, message.channelId, message.id);
    return this.store.getCase(c.id) ?? { ...c, channelId: message.channelId, messageId: message.id };
  }

  /** Re-render an open card after a vote or a statement. */
  async refresh(caseId: number): Promise<void> {
    const c = this.store.getCase(caseId);
    if (!c?.messageId || c.status !== "open") return;
    const message = await this.channel.messages.fetch(c.messageId).catch(() => null);
    if (message) await message.edit(openCard(c, this.policy, this.engine.tally(c), this.store.statements(c.id)));
  }

  /** Apply what a settled case decided, replace its card with the result, and log it. */
  async settle(s: Settled): Promise<void> {
    const notes = await this.actions.applyAll(s.effects, s.case);
    const tally = this.engine.tally(s.case);
    const card = closedCard(s.case, this.policy, tally, this.store.statements(s.case.id), s.effects, notes);
    const message = s.case.messageId ? await this.channel.messages.fetch(s.case.messageId).catch(() => null) : null;
    if (message) await message.edit(card);
    else await this.channel.send(card);
    await this.log(logLine(s.case, this.policy, tally, s.effects, notes));
  }

  /** Close cases past their deadline and lift bans that have run their course. */
  async runDue(): Promise<void> {
    for (const s of this.engine.closeDue()) {
      await this.settle(s).catch((e) => logger.error(`could not settle case #${s.case.id}`, e));
    }
    for (const job of this.store.dueScheduled(this.now())) {
      if (!this.store.finishScheduled(job.id, this.now())) continue;
      const c = this.engine.liftDueBan(job.userId, job.caseId);
      if (!c) continue;
      const notes = await this.actions.applyAll([{ type: "unban", userId: job.userId }], c);
      await this.log(unbanLogLine(job.caseId, job.userId, this.shadow, notes));
    }
  }

  /** Re-post cards for cases that were filed but never posted (a crash in between). */
  async repostMissing(): Promise<void> {
    for (const c of this.store.openCases()) if (!c.messageId) await this.open(c);
  }

  link(c: CaseRecord): string {
    return caseLink(c, this.guild.id) ?? `See ${channelMention(this.channel.id)}.`;
  }

  async log(text: string): Promise<void> {
    logger.info(text.replace(/<@(\d+)>/g, "@$1"));
    await this.logChannel
      .send({ content: text, allowedMentions: { parse: [] } })
      .catch((e) => logger.warn("could not write to the log channel", e));
  }
}
