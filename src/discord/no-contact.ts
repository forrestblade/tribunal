// Enforces no-contact orders: removes replies and mentions between the two
// people, and moves whoever joins the other's voice channel. Works from
// mention and voice-state events only, so it needs no message content.
import type { Client, Message, VoiceState } from "discord.js";
import { channelMention, mention } from "../format.js";
import type { Store } from "../store.js";
import { TtlMap } from "../ttl-map.js";
import type { Court } from "./court.js";
import { noContactReminder } from "./render.js";

const REMIND_EVERY = 10 * 60_000;

export interface NoContactOptions {
  client: Client;
  store: Store;
  court: Court;
  guildName: string;
  shadow: boolean;
  now?: () => number;
}

export class NoContactGuard {
  private readonly client: Client;
  private readonly store: Store;
  private readonly court: Court;
  private readonly guildName: string;
  private readonly shadow: boolean;
  private readonly now: () => number;
  /** So a reminder DM goes out once per pair per ten minutes, not once per deleted message. */
  private readonly reminded: TtlMap<string, true>;

  constructor(o: NoContactOptions) {
    this.client = o.client;
    this.store = o.store;
    this.court = o.court;
    this.guildName = o.guildName;
    this.shadow = o.shadow;
    this.now = o.now ?? Date.now;
    this.reminded = new TtlMap(REMIND_EVERY, this.now);
  }

  /** Returns true if the message was removed (and so needs no further handling). */
  async onMessage(m: Message<true>): Promise<boolean> {
    for (const { other, caseId, until } of this.ordersFor(m.author.id)) {
      const touches = m.mentions.users.has(other) || m.mentions.repliedUser?.id === other;
      if (!touches) continue;
      const what = `a message from ${mention(m.author.id)} that mentioned or replied to ${mention(other)} (case #${caseId})`;
      if (this.shadow) {
        await this.court.log(`No-contact (trial run): would have removed ${what}.`);
      } else {
        await m.delete().catch(() => undefined);
        await this.court.log(`No-contact: removed ${what}.`);
      }
      await this.remind(m.author.id, other, until, "messages that mention or reply to");
      return !this.shadow;
    }
    return false;
  }

  /** Someone joined or moved to a voice channel. */
  async onVoiceJoin(state: VoiceState): Promise<void> {
    const channelId = state.channelId;
    if (!channelId) return;
    for (const { other, caseId, until } of this.ordersFor(state.id)) {
      if (state.guild.voiceStates.cache.get(other)?.channelId !== channelId) continue;
      const what = `${mention(state.id)} out of ${channelMention(channelId)} because ${mention(other)} is there (case #${caseId})`;
      if (this.shadow) {
        await this.court.log(`No-contact (trial run): would have moved ${what}.`);
      } else {
        await state.disconnect(`Tribunal no-contact order, case #${caseId}`).catch(() => undefined);
        await this.court.log(`No-contact: moved ${what}.`);
      }
      await this.remind(state.id, other, until, "you from voice channels shared with");
    }
  }

  private ordersFor(userId: string): { other: string; caseId: number; until: number }[] {
    return this.store
      .activeNoContacts(this.now(), this.shadow)
      .filter((o) => o.aId === userId || o.bId === userId)
      .map((o) => ({ other: o.aId === userId ? o.bId : o.aId, caseId: o.caseId, until: o.until }));
  }

  private async remind(userId: string, other: string, until: number, what: string): Promise<void> {
    const key = `${userId}:${other}`;
    if (this.reminded.get(key)) return;
    this.reminded.set(key, true);
    const user = await this.client.users.fetch(userId).catch(() => null);
    await user?.send(noContactReminder(this.guildName, other, until, what, this.shadow)).catch(() => undefined);
  }
}
