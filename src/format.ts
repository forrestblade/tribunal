// Small text helpers shared by the engine and the Discord layer. The engine's
// refusal messages are shown to Discord users as-is, so they use Discord's
// timestamp and mention markup; this is the only Discord-specific thing it knows.

const HOUR = 60; // minutes
const DAY = 24 * HOUR;

export const mention = (userId: string): string => `<@${userId}>`;

export const channelMention = (channelId: string): string => `<#${channelId}>`;

/** A Discord timestamp that renders in each reader's own timezone. */
export function when(ms: number, style: "R" | "f" | "t" | "D" = "f"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatMinutes(minutes: number): string {
  if (minutes % DAY === 0) return `${minutes / DAY} day${minutes === DAY ? "" : "s"}`;
  if (minutes % HOUR === 0) return `${minutes / HOUR}h`;
  return `${minutes} min`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
