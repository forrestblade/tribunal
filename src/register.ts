// Registers the slash commands and context menus on the one server in config.json.
// Run once after installing and again whenever the policy's step list or the rules change.
import { REST, Routes } from "discord.js";
import { loadConfig } from "./config.js";
import { buildCommands } from "./discord/commands.js";

const config = loadConfig();
const rest = new REST().setToken(config.token);
const body = buildCommands(config.policy, config.rules);
const result = (await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body })) as {
  name: string;
}[];
console.log(`registered ${result.length} commands on guild ${config.guildId}: ${result.map((c) => c.name).join(", ")}`);
