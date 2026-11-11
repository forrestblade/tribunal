import type { Guild, GuildMember } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import type { MemberInfo } from "../engine/engine.js";
import type { Store } from "../store.js";

export function toMemberInfo(m: GuildMember): MemberInfo {
  const me = m.guild.members.me;
  const outranksBot = me ? m.roles.highest.comparePositionTo(me.roles.highest) >= 0 : false;
  return {
    id: m.id,
    name: m.displayName,
    isBot: m.user.bot,
    immune: m.id === m.guild.ownerId || m.permissions.has(PermissionFlagsBits.Administrator) || outranksBot,
    joinedAt: m.joinedTimestamp,
    timedOutUntil: m.communicationDisabledUntilTimestamp,
    voiceChannelId: m.voice.channelId,
  };
}

/** Everyone in the server right now, and note their join dates so rejoining does not reset membership. */
export async function allMembers(guild: Guild, store: Store): Promise<MemberInfo[]> {
  const members = await guild.members.fetch();
  const infos: MemberInfo[] = [];
  store.tx(() => {
    for (const m of members.values()) {
      if (m.joinedTimestamp) store.seen(m.id, m.joinedTimestamp);
      infos.push(toMemberInfo(m));
    }
  });
  return infos;
}
