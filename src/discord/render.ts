// Everything the bot says, built from plain data so it can be tested without Discord.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from "discord.js";
import type { Effect, Tally } from "../engine/engine.js";
import { formatMinutes, SHARE_TEXT, stepLabel, type Policy } from "../policy.js";
import type { CaseRecord, StatementRecord } from "../types.js";

const ts = (ms: number, style: "R" | "f" | "t" = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const user = (id: string) => `<@${id}>`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const COLORS = { open: 0x5865f2, passed: 0xed4245, failed: 0x57f287, shadow: 0x95a5a6 } as const;

export function caseTitle(c: CaseRecord, policy: Policy): string {
  const what =
    c.kind === "nocontact" ? "No-contact order" : c.kind === "appeal" ? "Appeal" : stepLabel(policy, c.stepId ?? "");
  return `Case #${c.id}: ${what}`;
}

function requirementText(c: CaseRecord): string {
  const r = c.requirement;
  const parts = [`${r.yes} yes`, SHARE_TEXT[r.share]];
  if (r.witnessYes > 0) parts.push(`${r.witnessYes} yes from people who were in voice`);
  return parts.join(", ");
}

function describe(c: CaseRecord, policy: Policy): string {
  switch (c.kind) {
    case "nocontact":
      return `${user(c.targetId)} and ${user(c.partyBId!)} would be under a ${policy.noContact.days} day no-contact order: the bot removes replies and mentions between them, and moves whoever joins the other's voice channel.`;
    case "appeal":
      return `Lift ${user(c.targetId)}'s ban from case #${c.appealOf}.`;
    default: {
      const level = c.targetLevel === null ? "newcomer track" : `level ${c.targetLevel}`;
      return `${user(c.targetId)} (${level}) is accused by ${user(c.proposerId)}.`;
    }
  }
}

export function openCard(c: CaseRecord, policy: Policy, tally: Tally, statements: StatementRecord[]) {
  const fields: APIEmbedField[] = [];
  if (c.rule) fields.push({ name: "Rule", value: c.rule, inline: true });
  fields.push({ name: "Where", value: c.voice ? "Voice chat" : "Text", inline: true });
  fields.push({ name: "Reason", value: clip(c.reason, 1000) });
  if (c.evidence) {
    const e = c.evidence;
    const lines: string[] = [];
    if (e.content) lines.push(`> ${clip(e.content, 600).replace(/\n/g, "\n> ")}`);
    if (e.attachments.length) lines.push(e.attachments.map((a) => `[${a.name}](${a.url})`).join(", "));
    if (e.url) lines.push(`[Jump to message](${e.url})`);
    if (lines.length) fields.push({ name: "Evidence", value: clip(lines.join("\n"), 1024) });
  }
  for (const s of statements) fields.push({ name: `Statement from ${s.userId === c.targetId || s.userId === c.partyBId ? "the accused" : "a party"}`, value: `${user(s.userId)}: ${clip(s.text, 900)}` });
  fields.push({ name: "Needs", value: requirementText(c), inline: true });
  fields.push({ name: "Closes", value: ts(c.closesAt), inline: true });
  fields.push({ name: "Turnout", value: `${tally.votes.length} of ${c.electorate.length} have voted`, inline: true });

  const embed = new EmbedBuilder()
    .setTitle(caseTitle(c, policy))
    .setDescription(describe(c, policy))
    .addFields(fields)
    .setColor(c.shadow ? COLORS.shadow : COLORS.open)
    .setFooter({ text: c.shadow ? "Trial run: the vote is real, the punishment is not applied." : "Votes are hidden until the case closes. Names are public afterwards." });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vote:${c.id}:yes`).setLabel("Yes").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`vote:${c.id}:no`).setLabel("No").setStyle(ButtonStyle.Secondary),
  );
  if (c.kind !== "appeal") row.addComponents(new ButtonBuilder().setCustomId(`stmt:${c.id}`).setLabel("Statement").setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row] };
}

export function effectText(e: Effect, shadow: boolean): string {
  const would = shadow ? "Would " : "";
  const lower = (s: string) => (shadow ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  switch (e.type) {
    case "cooloff":
      return `${would}${lower(`Timed out ${user(e.userId)} for ${e.minutes} minutes`)}.`;
    case "warn":
      return `${would}${lower(`Warned ${user(e.userId)} by DM`)}.`;
    case "timeout":
      return `${would}${lower(`Timed out ${user(e.userId)} for ${formatMinutes(e.minutes)}`)}.`;
    case "kick":
      return `${would}${lower(`Kicked ${user(e.userId)}`)}.`;
    case "ban":
      return `${would}${lower(`Banned ${user(e.userId)}${e.days === null ? " permanently" : ` for ${e.days} days`}`)}.`;
    case "unban":
      return `${would}${lower(`Unbanned ${user(e.userId)}`)}.`;
    case "noContact":
      return `${would}${lower(`Put ${user(e.aId)} and ${user(e.bId)} under a no-contact order until ${ts(e.until, "f")}`)}.`;
  }
}

export function closedCard(c: CaseRecord, policy: Policy, tally: Tally, statements: StatementRecord[], effects: Effect[], notes: string[]) {
  const yes = tally.votes.filter((v) => v.value === "yes").map((v) => user(v.voterId));
  const no = tally.votes.filter((v) => v.value === "no").map((v) => user(v.voterId));
  const fields: APIEmbedField[] = [
    { name: "Result", value: c.status === "passed" ? "Passed" : "Did not pass", inline: true },
    { name: "Votes", value: `${tally.yes} yes, ${tally.no} no, ${tally.remaining} did not vote (needed ${requirementText(c)})`, inline: true },
  ];
  if (c.rule) fields.push({ name: "Rule", value: c.rule, inline: true });
  fields.push({ name: "Reason", value: clip(c.reason, 1000) });
  for (const s of statements) fields.push({ name: "Statement", value: `${user(s.userId)}: ${clip(s.text, 900)}` });
  fields.push({ name: "Yes", value: yes.length ? clip(yes.join(" "), 1024) : "nobody" });
  fields.push({ name: "No", value: no.length ? clip(no.join(" "), 1024) : "nobody" });
  const action = [...effects.map((e) => effectText(e, c.shadow)), ...notes];
  if (action.length) fields.push({ name: c.shadow ? "Trial run" : "Action", value: clip(action.join("\n"), 1024) });
  const embed = new EmbedBuilder()
    .setTitle(caseTitle(c, policy))
    .setDescription(describe(c, policy))
    .addFields(fields)
    .setColor(c.shadow ? COLORS.shadow : c.status === "passed" ? COLORS.passed : COLORS.failed)
    .setFooter({ text: `Filed by ${c.proposerId === c.targetId ? "?" : "a member"} ${c.voice ? "about voice chat" : "about text"}. Closed` })
    .setTimestamp(c.closedAt ?? Date.now());
  return { embeds: [embed], components: [] };
}

export function logLine(c: CaseRecord, policy: Policy, tally: Tally, effects: Effect[], notes: string[]): string {
  const head = `${caseTitle(c, policy)} ${c.status === "passed" ? "passed" : "failed"} ${tally.yes}-${tally.no}.`;
  const body = [...effects.map((e) => effectText(e, c.shadow)), ...notes];
  return [head, ...body].join(" ");
}

export function dmForEffect(e: Effect, c: CaseRecord, policy: Policy, guildName: string, appealHint: string | null): string | null {
  const head = `In **${guildName}**, case #${c.id} passed${c.rule ? ` under the rule "${c.rule}"` : ""}. Reason given: ${clip(c.reason, 500)}`;
  switch (e.type) {
    case "warn":
      return `${head}\n\nThis is a warning. It counts as a strike for ${policy.strikeWindowDays} days; strikes fade one level every ${policy.decayDays} clean days.`;
    case "cooloff":
      return `${head}\n\nYou're timed out for ${e.minutes} minutes to cool off. This is not a strike.`;
    case "timeout":
      return `${head}\n\nYou're timed out for ${formatMinutes(e.minutes)}.`;
    case "kick":
      return `${head}\n\nYou've been removed from the server. You can rejoin with an invite.`;
    case "ban":
      return `${head}\n\nYou're banned ${e.days === null ? "permanently" : `for ${e.days} days`}.${appealHint ? ` ${appealHint}` : ""}`;
    default:
      return null;
  }
}

export function helpText(policy: Policy, rules: string[], shadow: boolean): string {
  const steps = policy.memberSteps.map((s) => `• ${s.label}: ${s.yes} yes, ${SHARE_TEXT[s.share]}, ${formatMinutes(s.windowMinutes)} to vote${s.level === null ? " (no strike)" : ` (level ${s.level})`}`);
  const newcomer = policy.newcomerSteps.map((s) => `• ${s.label}: ${s.yes} yes, ${SHARE_TEXT[s.share]}, ${formatMinutes(s.windowMinutes)}`);
  return [
    shadow ? "**Trial run.** Cases and votes are real, nothing is applied yet." : "",
    "**How it works.** Anyone who's been here " + `${policy.memberMinDays}+ days can file a case with \`/case\`, by right-clicking a person or message, or by tagging me with the person. Everyone eligible votes Yes or No. The tally is hidden until the case closes, then names are public.`,
    "**Who votes.** Members who've been here " + `${policy.memberMinDays}+ days, aren't timed out, aren't in the case, and haven't filed against (or been filed against by) the people in it in the last ${policy.involvementDays} days. The person filing doesn't vote.`,
    "**Steps.** Punishments go up one level at a time. Strikes fade a level every " + `${policy.decayDays} clean days and vanish after ${policy.strikeWindowDays}.`,
    steps.join("\n"),
    `**Newcomers** (under ${policy.memberMinDays} days):\n${newcomer.join("\n")}`,
    `**Voice.** For something that happened in voice, the person filing must have been in the channel in the last ${policy.witnessWindowMinutes} minutes, and some yes votes must come from people who were there too. Nothing is recorded.`,
    `**Feuds.** After A files against B, B can't file against A for ${policy.retaliationLockHours}h, but can post a statement. Someone outside a feud can propose a ${policy.noContact.days} day no-contact order with \`/nocontact\`.`,
    `**Bans** can be appealed with \`/appeal\` by any member once half the ban has passed (${policy.appeal.permanentAfterDays} days for permanent). \`/record\` shows anyone's strikes. \`/status\` shows open cases.`,
    `**Brake.** More than ${policy.breaker.maxCasesPerHour} cases in an hour pauses filing for ${policy.breaker.pauseMinutes} minutes.`,
    rules.length ? `**Rules:** ${rules.join(" · ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
