// Applies the engine's effects to Discord. The only file that kicks, bans or times anyone out.
import { DiscordAPIError, RESTJSONErrorCodes, type Guild, type GuildMember } from "discord.js";
import type { Effect } from "../engine/engine.js";
import { errorMessage } from "../logger.js";
import type { Policy } from "../policy.js";
import type { Store } from "../store.js";
import type { CaseRecord } from "../types.js";
import { dmForEffect } from "./render.js";

const MIN = 60_000;

/** Effects aimed at one person that the bot carries out directly. */
type Punishment = Exclude<Effect, { type: "noContact" | "unban" }>;

export interface ActionsOptions {
  guild: Guild;
  store: Store;
  policy: Policy;
  /** In a trial run nothing is applied, but the accused is still told what would have happened. */
  shadow: boolean;
  now?: () => number;
}

export class Actions {
  private readonly guild: Guild;
  private readonly store: Store;
  private readonly policy: Policy;
  private readonly shadow: boolean;
  private readonly now: () => number;

  constructor(o: ActionsOptions) {
    this.guild = o.guild;
    this.store = o.store;
    this.policy = o.policy;
    this.shadow = o.shadow;
    this.now = o.now ?? Date.now;
  }

  /** Apply every effect of a settled case. Returns notes for the log: anything that did not go to plan. */
  async applyAll(effects: Effect[], c: CaseRecord): Promise<string[]> {
    const notes: string[] = [];
    for (const e of effects) {
      try {
        notes.push(...(await this.apply(e, c)));
      } catch (err) {
        notes.push(`Could not apply ${e.type}: ${errorMessage(err)}`);
      }
    }
    return notes;
  }

  async apply(e: Effect, c: CaseRecord): Promise<string[]> {
    const reason = this.auditReason(c);
    switch (e.type) {
      case "noContact":
        return [];
      case "unban":
        return this.unban(e.userId, reason);
      case "warn":
      case "cooloff":
      case "timeout":
      case "kick":
      case "ban": {
        // Tell them first: after a kick or ban the bot usually cannot DM them.
        const notes = await this.notify(e, c);
        if (this.shadow) return notes;
        return [...notes, ...(await this.punish(e, c, reason))];
      }
    }
  }

  /** Timeouts owed to someone who left before they could be applied. */
  async applyOwed(member: GuildMember): Promise<void> {
    if (this.shadow) return;
    for (const p of this.store.pending(member.id, "timeout")) {
      if (!this.store.takePending(p.id)) continue;
      await member
        .timeout((p.minutes ?? 10) * MIN, `Tribunal case #${p.caseId}, applied on return`)
        .catch(() => undefined);
    }
  }

  private auditReason(c: CaseRecord): string {
    return `Tribunal case #${c.id}${c.rule ? `: ${c.rule}` : ""} (${this.shadow ? "trial run" : "voted"})`;
  }

  private async notify(e: Punishment, c: CaseRecord): Promise<string[]> {
    const text = dmForEffect(e, c, this.policy, this.guild.name);
    if (!text) return [];
    const prefix = this.shadow ? "Trial run, nothing is applied yet, but this is what the vote decided.\n\n" : "";
    const sent = await this.dm(e.userId, prefix + text);
    return sent ? [] : ["Could not DM them (DMs closed)."];
  }

  private async punish(e: Punishment, c: CaseRecord, reason: string): Promise<string[]> {
    switch (e.type) {
      case "warn":
        return [];
      case "cooloff":
      case "timeout":
        return this.timeout(e.userId, e.minutes, c.id, reason);
      case "kick":
        return this.kick(e.userId, reason);
      case "ban":
        await this.guild.members.ban(e.userId, { reason, deleteMessageSeconds: 0 });
        return [];
    }
  }

  private async timeout(userId: string, minutes: number, caseId: number, reason: string): Promise<string[]> {
    const member = await this.fetchMember(userId);
    if (!member) {
      this.store.addPending("timeout", userId, caseId, minutes, this.now());
      return ["They have left the server; the timeout will be applied if they come back."];
    }
    await member.timeout(minutes * MIN, reason);
    if (member.voice.channelId) await member.voice.disconnect(reason).catch(() => undefined);
    return [];
  }

  private async kick(userId: string, reason: string): Promise<string[]> {
    const member = await this.fetchMember(userId);
    if (!member) return ["They had already left the server."];
    await member.kick(reason);
    return [];
  }

  private async unban(userId: string, reason: string): Promise<string[]> {
    if (this.shadow) return [];
    try {
      await this.guild.members.unban(userId, reason);
      return [];
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownBan) {
        return ["They were not banned in Discord any more."];
      }
      return [`Could not unban: ${errorMessage(err)}`];
    }
  }

  private async fetchMember(userId: string): Promise<GuildMember | null> {
    try {
      return await this.guild.members.fetch(userId);
    } catch (e) {
      const gone =
        e instanceof DiscordAPIError &&
        (e.code === RESTJSONErrorCodes.UnknownMember || e.code === RESTJSONErrorCodes.UnknownUser);
      if (gone) return null;
      throw e;
    }
  }

  private async dm(userId: string, text: string): Promise<boolean> {
    try {
      const user = await this.guild.client.users.fetch(userId);
      await user.send(text);
      return true;
    } catch {
      return false;
    }
  }
}
