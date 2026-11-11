import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { allStepIds, stepLabel, type Policy } from "../policy.js";

export const COMMANDS = {
  case: "case",
  nocontact: "nocontact",
  appeal: "appeal",
  record: "record",
  status: "status",
  help: "help",
  userMenu: "File a case",
  messageMenu: "File a case about this",
} as const;

/** Option names, shared with the handlers so a rename cannot drift. */
export const OPTIONS = {
  who: "who",
  punishment: "punishment",
  reason: "reason",
  rule: "rule",
  voice: "voice",
  first: "first",
  second: "second",
} as const;

export const OTHER_RULE = "Other";
export const REASON_MAX = 500;

export function buildCommands(policy: Policy, rules: string[]): RESTPostAPIApplicationCommandsJSONBody[] {
  const stepChoices = allStepIds(policy).map((id) => ({ name: stepLabel(policy, id), value: id }));
  const ruleChoices = [...rules.slice(0, 24), OTHER_RULE].map((r) => ({ name: r, value: r }));
  const guildOnly = InteractionContextType.Guild;

  const caseCmd = new SlashCommandBuilder()
    .setName(COMMANDS.case)
    .setDescription("Put a punishment to a vote")
    .setContexts(guildOnly)
    .addUserOption((o) => o.setName(OPTIONS.who).setDescription("The person").setRequired(true))
    .addStringOption((o) =>
      o
        .setName(OPTIONS.punishment)
        .setDescription("What you're asking for")
        .setRequired(true)
        .addChoices(...stepChoices),
    )
    .addStringOption((o) =>
      o
        .setName(OPTIONS.reason)
        .setDescription("What happened, in your words")
        .setRequired(true)
        .setMaxLength(REASON_MAX),
    )
    .addStringOption((o) =>
      o
        .setName(OPTIONS.rule)
        .setDescription("Which rule it breaks")
        .addChoices(...ruleChoices),
    )
    .addBooleanOption((o) =>
      o.setName(OPTIONS.voice).setDescription("Did it happen in voice chat? Defaults to yes if they're in voice now"),
    );

  const nocontact = new SlashCommandBuilder()
    .setName(COMMANDS.nocontact)
    .setDescription("Propose a no-contact order between two people who keep fighting")
    .setContexts(guildOnly)
    .addUserOption((o) => o.setName(OPTIONS.first).setDescription("One of them").setRequired(true))
    .addUserOption((o) => o.setName(OPTIONS.second).setDescription("The other").setRequired(true))
    .addStringOption((o) =>
      o.setName(OPTIONS.reason).setDescription("What's been going on").setRequired(true).setMaxLength(REASON_MAX),
    );

  const appeal = new SlashCommandBuilder()
    .setName(COMMANDS.appeal)
    .setDescription("Propose lifting a ban the server voted for")
    .setContexts(guildOnly)
    .addStringOption((o) =>
      o.setName(OPTIONS.who).setDescription("The banned person").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName(OPTIONS.reason)
        .setDescription("Why they should be let back in")
        .setRequired(true)
        .setMaxLength(REASON_MAX),
    );

  const record = new SlashCommandBuilder()
    .setName(COMMANDS.record)
    .setDescription("Show someone's level and strikes")
    .setContexts(guildOnly)
    .addUserOption((o) => o.setName(OPTIONS.who).setDescription("Defaults to you"));

  const status = new SlashCommandBuilder()
    .setName(COMMANDS.status)
    .setDescription("Open cases and whether filing is paused")
    .setContexts(guildOnly);

  const help = new SlashCommandBuilder()
    .setName(COMMANDS.help)
    .setDescription("How the tribunal works")
    .setContexts(guildOnly);

  const userMenu = new ContextMenuCommandBuilder()
    .setName(COMMANDS.userMenu)
    .setType(ApplicationCommandType.User)
    .setContexts(guildOnly);
  const messageMenu = new ContextMenuCommandBuilder()
    .setName(COMMANDS.messageMenu)
    .setType(ApplicationCommandType.Message)
    .setContexts(guildOnly);

  return [caseCmd, nocontact, appeal, record, status, help, userMenu, messageMenu].map((c) => c.toJSON());
}
