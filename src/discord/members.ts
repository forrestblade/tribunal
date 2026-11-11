import { PermissionFlagsBits, type Guild, type GuildMember, type Message } from "discord.js";
import type { MemberInfo } from "../engine/engine.js";
import type { Store } from "../store.js";
import type { Evidence } from "../types.js";

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

/** Everyone in the server right now. Also notes join dates so rejoining does not reset membership. */
export async function fetchMembers(guild: Guild, store: Store): Promise<MemberInfo[]> {
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

export function evidenceFrom(m: Message): Evidence {
  return {
    channelId: m.channelId,
    messageId: m.id,
    url: m.url,
    authorId: m.author.id,
    content: m.content || null,
    attachments: m.attachments.map((a) => ({ name: a.name, url: a.url, size: a.size })),
  };
}
