// "@bot @them what they did" in any channel: reply with a button that opens the
// filing form with the words already in the reason box. Discord delivers the
// text of messages that mention the bot without the Message Content intent.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type Message, type User } from "discord.js";
import { mention } from "../format.js";
import { encodeCustomId } from "./custom-ids.js";
import type { Drafts } from "./drafts.js";

const LABEL_MAX = 80;

export class MentionFiling {
  constructor(
    private readonly client: Client,
    private readonly drafts: Drafts,
  ) {}

  /** Returns true if the message was addressed to the bot. */
  async onMessage(m: Message<true>): Promise<boolean> {
    const me = this.client.user;
    if (!me || !m.mentions.has(me, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) return false;

    const target = this.targetOf(m, me.id);
    if (!target) {
      await m.reply({
        content: "Tag the person too, like `@me @them what they did`, or use /case.",
        allowedMentions: { parse: [] },
      });
      return true;
    }

    const evidence = m.reference?.messageId
      ? { channelId: m.reference.channelId, messageId: m.reference.messageId }
      : null;
    const button = new ButtonBuilder()
      .setCustomId(encodeCustomId({ kind: "open", targetId: target.id, evidence }))
      .setLabel(`Open the form against ${target.displayName}`.slice(0, LABEL_MAX))
      .setStyle(ButtonStyle.Primary);
    const reply = await m.reply({
      content: `${mention(m.author.id)}, press the button to pick the punishment and file it.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      allowedMentions: { users: [m.author.id] },
    });
    this.drafts.reasons.set(reply.id, { authorId: m.author.id, reason: m.content.replace(/<@!?\d+>/g, "").trim() });
    return true;
  }

  /** The first person mentioned who is not a bot; failing that, the author of the message being replied to. */
  private targetOf(m: Message<true>, botId: string): User | null {
    const replied = m.mentions.repliedUser;
    const tagged = m.mentions.users.find((u) => u.id !== botId && !u.bot && u.id !== replied?.id);
    if (tagged) return tagged;
    return replied && !replied.bot ? replied : null;
  }
}
