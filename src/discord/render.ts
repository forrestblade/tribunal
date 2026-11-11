// Everything the bot says, built from plain data so it can be tested without Discord.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type APIEmbedField } from "discord.js";
import type { Effect, MemberInfo, MemberRecord, Tally } from "../engine/engine.js";
import { clip, formatMinutes, mention, when } from "../format.js";
import { SHARE_TEXT, stepLabel, type Policy } from "../policy.js";
import type { CaseRecord, StatementRecord } from "../types.js";
import { encodeCustomId } from "./custom-ids.js";

export const COLORS = { open: 0x5865f2, passed: 0xed4245, failed: 0x57f287, shadow: 0x95a5a6, info: 0x5865f2 } as const;

const FIELD_MAX = 1024;

export function caseTitle(c: CaseRecord, policy: Policy): string {
  const what =
    c.kind === "nocontact" ? "No-contact order" : c.kind === "appeal" ? "Appeal" : stepLabel(policy, c.stepId ?? "");
  return `Case #${c.id}: ${what}`;
}

export function caseLink(c: CaseRecord, guildId: string): string | null {
  return c.channelId && c.messageId ? `https://discord.com/channels/${guildId}/${c.channelId}/${c.messageId}` : null;
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
      return `${mention(c.targetId)} and ${mention(c.partyBId!)} would be under a ${policy.noContact.days} day no-contact order: the bot removes replies and mentions between them, and moves whoever joins the other's voice channel.`;
    case "appeal":
      return `Lift ${mention(c.targetId)}'s ban from case #${c.appealOf}.`;
    case "sanction": {
      const level = c.targetLevel === null ? "newcomer track" : `level ${c.targetLevel}`;
      return `${mention(c.targetId)} (${level}) is accused by ${mention(c.proposerId)}.`;
    }
  }
}

function evidenceText(c: CaseRecord): string | null {
  const e = c.evidence;
  if (!e) return null;
  const lines: string[] = [];
  if (e.content) lines.push(`> ${clip(e.content, 600).replace(/\n/g, "\n> ")}`);
  if (e.attachments.length) lines.push(e.attachments.map((a) => `[${a.name}](${a.url})`).join(", "));
  lines.push(`[Jump to message](${e.url})`);
  return clip(lines.join("\n"), FIELD_MAX);
}

function statementFields(statements: StatementRecord[]): APIEmbedField[] {
  return statements.map((s) => ({ name: "Statement", value: `${mention(s.userId)}: ${clip(s.text, 900)}` }));
}

export function openCard(c: CaseRecord, policy: Policy, tally: Tally, statements: StatementRecord[]) {
  const fields: APIEmbedField[] = [];
  if (c.rule) fields.push({ name: "Rule", value: c.rule, inline: true });
  if (c.kind === "sanction") fields.push({ name: "Where", value: c.voice ? "Voice chat" : "Text", inline: true });
  fields.push({ name: "Reason", value: clip(c.reason, 1000) });
  const evidence = evidenceText(c);
  if (evidence) fields.push({ name: "Evidence", value: evidence });
  fields.push(...statementFields(statements));
  fields.push(
    { name: "Needs", value: requirementText(c), inline: true },
    { name: "Closes", value: when(c.closesAt, "R"), inline: true },
    { name: "Turnout", value: `${tally.votes.length} of ${c.electorate.length} have voted`, inline: true },
  );

  const embed = new EmbedBuilder()
    .setTitle(caseTitle(c, policy))
    .setDescription(describe(c, policy))
    .addFields(fields)
    .setColor(c.shadow ? COLORS.shadow : COLORS.open)
    .setFooter({
      text: c.shadow
        ? "Trial run: the vote is real, the punishment is not applied."
        : "Votes are hidden until the case closes. Names are public afterwards.",
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ kind: "vote", caseId: c.id, value: "yes" }))
      .setLabel("Yes")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ kind: "vote", caseId: c.id, value: "no" }))
      .setLabel("No")
      .setStyle(ButtonStyle.Secondary),
  );
  if (c.kind !== "appeal") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ kind: "statement", caseId: c.id }))
        .setLabel("Statement")
        .setStyle(ButtonStyle.Primary),
    );
  }
  return { embeds: [embed], components: [row] };
}

export function effectText(e: Effect, shadow: boolean): string {
  const [did, would] = ((): [string, string] => {
    switch (e.type) {
      case "cooloff":
        return [
          `Timed out ${mention(e.userId)} for ${e.minutes} minutes`,
          `Would time out ${mention(e.userId)} for ${e.minutes} minutes`,
        ];
      case "warn":
        return [`Warned ${mention(e.userId)} by DM`, `Would warn ${mention(e.userId)} by DM`];
      case "timeout":
        return [
          `Timed out ${mention(e.userId)} for ${formatMinutes(e.minutes)}`,
          `Would time out ${mention(e.userId)} for ${formatMinutes(e.minutes)}`,
        ];
      case "kick":
        return [`Kicked ${mention(e.userId)}`, `Would kick ${mention(e.userId)}`];
      case "ban": {
        const span = e.days === null ? " permanently" : ` for ${e.days} days`;
        return [`Banned ${mention(e.userId)}${span}`, `Would ban ${mention(e.userId)}${span}`];
      }
      case "unban":
        return [`Unbanned ${mention(e.userId)}`, `Would unban ${mention(e.userId)}`];
      case "noContact":
        return [
          `Put ${mention(e.aId)} and ${mention(e.bId)} under a no-contact order until ${when(e.until)}`,
          `Would put ${mention(e.aId)} and ${mention(e.bId)} under a no-contact order until ${when(e.until)}`,
        ];
    }
  })();
  return `${shadow ? would : did}.`;
}

export function closedCard(
  c: CaseRecord,
  policy: Policy,
  tally: Tally,
  statements: StatementRecord[],
  effects: Effect[],
  notes: string[],
) {
  const names = (value: "yes" | "no") => tally.votes.filter((v) => v.value === value).map((v) => mention(v.voterId));
  const yes = names("yes");
  const no = names("no");
  const fields: APIEmbedField[] = [
    { name: "Result", value: c.status === "passed" ? "Passed" : "Did not pass", inline: true },
    {
      name: "Votes",
      value: `${tally.yes} yes, ${tally.no} no, ${tally.remaining} did not vote (needed ${requirementText(c)})`,
      inline: true,
    },
  ];
  if (c.rule) fields.push({ name: "Rule", value: c.rule, inline: true });
  fields.push({ name: "Reason", value: clip(c.reason, 1000) });
  fields.push(...statementFields(statements));
  fields.push({ name: "Yes", value: yes.length ? clip(yes.join(" "), FIELD_MAX) : "nobody" });
  fields.push({ name: "No", value: no.length ? clip(no.join(" "), FIELD_MAX) : "nobody" });
  const action = [...effects.map((e) => effectText(e, c.shadow)), ...notes];
  if (action.length) {
    fields.push({ name: c.shadow ? "Trial run" : "Action", value: clip(action.join("\n"), FIELD_MAX) });
  }

  const embed = new EmbedBuilder()
    .setTitle(caseTitle(c, policy))
    .setDescription(describe(c, policy))
    .addFields(fields)
    .setColor(c.shadow ? COLORS.shadow : c.status === "passed" ? COLORS.passed : COLORS.failed)
    .setFooter({ text: c.voice ? "About voice chat. Closed" : "Closed" })
    .setTimestamp(c.closedAt ?? Date.now());
  return { embeds: [embed], components: [] };
}

export function logLine(c: CaseRecord, policy: Policy, tally: Tally, effects: Effect[], notes: string[]): string {
  const head = `${caseTitle(c, policy)} ${c.status === "passed" ? "passed" : "failed"} ${tally.yes}-${tally.no}.`;
  return [head, ...effects.map((e) => effectText(e, c.shadow)), ...notes].join(" ");
}

export function unbanLogLine(caseId: number, userId: string, shadow: boolean, notes: string[]): string {
  const verb = shadow ? "would have lifted" : "lifted";
  return [`Case #${caseId}: ${verb} ${mention(userId)}'s ban, time served.`, ...notes].join(" ");
}

export function dmForEffect(e: Effect, c: CaseRecord, policy: Policy, guildName: string): string | null {
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
    case "ban": {
      const appeal =
        e.days === null
          ? `Any member can propose lifting it with /appeal after ${policy.appeal.permanentAfterDays} days.`
          : "Any member can propose lifting it with /appeal once half the time has passed.";
      return `${head}\n\nYou're banned ${e.days === null ? "permanently" : `for ${e.days} days`}. ${appeal}`;
    }
    case "unban":
    case "noContact":
      return null;
  }
}

export function noContactReminder(
  guildName: string,
  otherId: string,
  until: number,
  what: string,
  shadow: boolean,
): string {
  const verb = shadow ? "will remove" : "removes";
  return `Reminder from **${guildName}**: you're under a no-contact order with ${mention(otherId)} until ${when(until)}. The bot ${verb} ${what} them.`;
}

export function recordEmbed(
  title: string,
  record: MemberRecord,
  info: MemberInfo | null,
  memberAgeDays: number | null,
  isMember: boolean,
  policy: Policy,
  now: number,
): EmbedBuilder {
  const proposable = record.canBeProposed.map((s) => s.label).join(", ") || "nothing";
  const standing = !info
    ? "Not in the server."
    : info.immune
      ? "Immune (owner, admin, or above the bot)."
      : `${isMember ? "Member" : "Newcomer"}, ${Math.floor(memberAgeDays ?? 0)} days here.`;
  const strikes = record.strikes.map((s) => {
    const what = s.stepId ? stepLabel(policy, s.stepId) : `level ${s.level}`;
    const ends =
      s.endsAt === null ? "permanent" : s.endsAt > now ? `ends ${when(s.endsAt, "R")}` : `ended ${when(s.endsAt, "D")}`;
    return `• Case #${s.caseId}: ${what}, ${ends}`;
  });
  const ban = record.ban
    ? `Banned by case #${record.ban.caseId}${record.ban.until ? `, until ${when(record.ban.until)}` : ", permanently"}.`
    : null;
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      [
        `Level **${record.level}** (${proposable} can be proposed).`,
        standing,
        ban,
        strikes.length
          ? `\n**Strikes (last ${policy.strikeWindowDays} days):**\n${strikes.join("\n")}`
          : "\nNo strikes.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    )
    .setColor(COLORS.info);
}

export function statusText(
  open: { case: CaseRecord; tally: Tally }[],
  pausedUntil: number | null,
  shadow: boolean,
  policy: Policy,
  guildId: string,
): string {
  const lines = open.map(({ case: c, tally }) => {
    const what =
      c.kind === "sanction"
        ? stepLabel(policy, c.stepId ?? "")
        : c.kind === "nocontact"
          ? "no-contact order"
          : "appeal";
    const who = c.partyBId ? `${mention(c.targetId)} and ${mention(c.partyBId)}` : mention(c.targetId);
    const link = caseLink(c, guildId);
    const label = link ? `[Case #${c.id}](${link})` : `Case #${c.id}`;
    return `• ${label}: ${what} on ${who}, ${tally.votes.length}/${c.electorate.length} voted, closes ${when(c.closesAt, "R")}`;
  });
  return [
    shadow ? "**Trial run.** Votes count, punishments are not applied." : "**Live.**",
    pausedUntil ? `Filing is paused until ${when(pausedUntil, "t")}.` : "Filing is open.",
    lines.length ? lines.join("\n") : "No open cases.",
  ].join("\n");
}

export function helpText(policy: Policy, rules: string[], shadow: boolean): string {
  const step = (s: Policy["memberSteps"][number]) =>
    `• ${s.label}: ${s.yes} yes, ${SHARE_TEXT[s.share]}, ${formatMinutes(s.windowMinutes)} to vote`;
  const memberSteps = policy.memberSteps.map(
    (s) => `${step(s)}${s.level === null ? " (no strike)" : ` (level ${s.level})`}`,
  );
  const newcomerSteps = policy.newcomerSteps.map(step);
  return [
    shadow ? "**Trial run.** Cases and votes are real, nothing is applied yet." : null,
    `**How it works.** Anyone who's been here ${policy.memberMinDays}+ days can file a case with \`/case\`, by right-clicking a person or message, or by tagging me with the person. Everyone eligible votes Yes or No. The tally is hidden until the case closes, then names are public.`,
    `**Who votes.** Members who've been here ${policy.memberMinDays}+ days, aren't timed out, aren't in the case, and haven't filed against (or been filed against by) the people in it in the last ${policy.involvementDays} days. The person filing doesn't vote.`,
    `**Steps.** Punishments go up one level at a time. Strikes fade a level every ${policy.decayDays} clean days and vanish after ${policy.strikeWindowDays}.`,
    memberSteps.join("\n"),
    `**Newcomers** (under ${policy.memberMinDays} days):\n${newcomerSteps.join("\n")}`,
    `**Voice.** For something that happened in voice, the person filing must have been in the channel in the last ${policy.witnessWindowMinutes} minutes, and some yes votes must come from people who were there too. Nothing is recorded.`,
    `**Feuds.** After A files against B, B can't file against A for ${policy.retaliationLockHours}h, but can post a statement. Someone outside a feud can propose a ${policy.noContact.days} day no-contact order with \`/nocontact\`.`,
    `**Bans** can be appealed with \`/appeal\` by any member once half the ban has passed (${policy.appeal.permanentAfterDays} days for permanent). \`/record\` shows anyone's strikes. \`/status\` shows open cases.`,
    `**Brake.** More than ${policy.breaker.maxCasesPerHour} cases in an hour pauses filing for ${policy.breaker.pauseMinutes} minutes.`,
    rules.length ? `**Rules:** ${rules.join(" · ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}
