// Prints the invite link with exactly the permissions the bot needs.
import { OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { loadConfig } from "./config.js";

export const REQUIRED_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.MoveMembers,
]);

const config = loadConfig();
const url = new URL("https://discord.com/oauth2/authorize");
url.searchParams.set("client_id", config.applicationId);
url.searchParams.set("scope", [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(" "));
url.searchParams.set("permissions", REQUIRED_PERMISSIONS.bitfield.toString());
url.searchParams.set("guild_id", config.guildId);
console.log(url.toString());
