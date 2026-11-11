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

export function buildCommands(policy: Policy, rules: string[]): RESTPostAPIApplicationCommandsJSONBody[] {
  const stepChoices = allStepIds(policy).map((id) => ({ name: stepLabel(policy, id), value: id }));
  const ruleChoices = rules.slice(0, 24).map((r) => ({ name: r, value: r }));

  const caseCmd = new SlashCommandBuilder()
    .setName(COMMANDS.case)
    .setDescription("Put a punishment to a vote")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("who").setDescription("The person").setRequired(true))
    .addStringOption((o) => o.setName("punishment").setDescription("What you're asking for").setRequired(true).addChoices(...stepChoices))
    .addStringOption((o) => o.setName("reason").setDescription("What happened, in your words").setRequired(true).setMaxLength(500))
    .addStringOption((o) => o.setName("rule").setDescription("Which rule it breaks").setRequired(false).addChoices(...ruleChoices, { name: "Other", value: "Other" }))
    .addBooleanOption((o) => o.setName("voice").setDescription("Did it happen in voice chat? Defaults to yes if they're in voice now").setRequired(false));

  const nocontact = new SlashCommandBuilder()
    .setName(COMMANDS.nocontact)
    .setDescription("Propose a no-contact order between two people who keep fighting")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("first").setDescription("One of them").setRequired(true))
    .addUserOption((o) => o.setName("second").setDescription("The other").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("What's been going on").setRequired(true).setMaxLength(500));

  const appeal = new SlashCommandBuilder()
    .setName(COMMANDS.appeal)
    .setDescription("Propose lifting a ban the server voted for")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName("who").setDescription("The banned person").setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName("reason").setDescription("Why they should be let back in").setRequired(true).setMaxLength(500));

  const record = new SlashCommandBuilder()
    .setName(COMMANDS.record)
    .setDescription("Show someone's level and strikes")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("who").setDescription("Defaults to you").setRequired(false));

  const status = new SlashCommandBuilder().setName(COMMANDS.status).setDescription("Open cases and whether filing is paused").setContexts(InteractionContextType.Guild);
  const help = new SlashCommandBuilder().setName(COMMANDS.help).setDescription("How the tribunal works").setContexts(InteractionContextType.Guild);

  const userMenu = new ContextMenuCommandBuilder().setName(COMMANDS.userMenu).setType(ApplicationCommandType.User).setContexts(InteractionContextType.Guild);
  const messageMenu = new ContextMenuCommandBuilder().setName(COMMANDS.messageMenu).setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild);

  return [caseCmd, nocontact, appeal, record, status, help, userMenu, messageMenu].map((c) => c.toJSON());
}
