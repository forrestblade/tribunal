import { DiscordAPIError, RESTJSONErrorCodes, type Guild, type GuildMember } from "discord.js";
import type { Effect } from "../engine/engine.js";
import type { Policy } from "../policy.js";
import type { Store } from "../store.js";
import type { CaseRecord } from "../types.js";
import { dmForEffect } from "./render.js";

const MIN = 60_000;

export interface Applied {
  /** Human-readable notes for the log: things that did not go to plan. */
  notes: string[];
}

async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId);
  } catch (e) {
    if (e instanceof DiscordAPIError && (e.code === RESTJSONErrorCodes.UnknownMember || e.code === RESTJSONErrorCodes.UnknownUser)) return null;
    throw e;
  }
}

async function dm(guild: Guild, userId: string, text: string): Promise<boolean> {
  try {
    const u = await guild.client.users.fetch(userId);
    await u.send(text);
    return true;
  } catch {
    return false;
  }
}

async function disconnectIfInVoice(member: GuildMember, reason: string) {
  if (member.voice.channelId) {
    try {
      await member.voice.disconnect(reason);
    } catch {
      /* they may have left already */
    }
  }
}

const describeError = (e: unknown) => (e instanceof DiscordAPIError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e));

/**
 * Apply one effect to Discord. In shadow mode nothing is applied, but the
 * accused is still told what would have happened so the trial run feels real.
 */
export async function applyEffect(e: Effect, c: CaseRecord, guild: Guild, store: Store, policy: Policy, shadow: boolean, now: () => number): Promise<Applied> {
  const notes: string[] = [];
  const reason = `Tribunal case #${c.id}${c.rule ? `: ${c.rule}` : ""} (${shadow ? "trial run" : "voted"})`;
  const appealHint =
    e.type === "ban"
      ? e.days === null
        ? `Any member can propose lifting it with /appeal after ${policy.appeal.permanentAfterDays} days.`
        : `Any member can propose lifting it with /appeal once half the time has passed.`
      : null;
  const text = dmForEffect(e, c, policy, guild.name, appealHint);
  const prefix = shadow ? "Trial run, nothing is applied yet, but this is what the vote decided.\n\n" : "";

  if (e.type === "noContact") return { notes };
  if (e.type === "unban") {
    if (shadow) return { notes };
    try {
      await guild.members.unban(e.userId, reason);
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownBan) notes.push("They were not banned in Discord any more.");
      else notes.push(`Could not unban: ${describeError(err)}`);
    }
    return { notes };
  }

  // Tell them first: after a kick or ban the bot usually cannot DM them.
  const told = text ? await dm(guild, e.userId, prefix + text) : false;
  if (text && !told) notes.push("Could not DM them (DMs closed).");
  if (shadow) return { notes };

  const member = await fetchMember(guild, e.userId);
  try {
    switch (e.type) {
      case "warn":
        break;
      case "cooloff":
      case "timeout": {
        if (!member) {
          store.addPending("timeout", e.userId, c.id, e.minutes, now());
          notes.push("They have left the server; the timeout will be applied if they come back.");
          break;
        }
        await member.timeout(e.minutes * MIN, reason);
        await disconnectIfInVoice(member, reason);
        break;
      }
      case "kick": {
        if (!member) {
          notes.push("They had already left the server.");
          break;
        }
        await member.kick(reason);
        break;
      }
      case "ban": {
        await guild.members.ban(e.userId, { reason, deleteMessageSeconds: 0 });
        break;
      }
    }
  } catch (err) {
    notes.push(`Could not apply it: ${describeError(err)}`);
  }
  return { notes };
}

/** Timeouts owed to someone who left before they could be applied. */
export async function applyPendingTimeouts(member: GuildMember, store: Store): Promise<void> {
  for (const p of store.pending(member.id, "timeout")) {
    if (!store.takePending(p.id)) continue;
    try {
      await member.timeout((p.minutes ?? 10) * MIN, `Tribunal case #${p.caseId}, applied on return`);
    } catch {
      /* role hierarchy may have changed; nothing more to do */
    }
  }
}
