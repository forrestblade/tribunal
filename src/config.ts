import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_POLICY, type Policy } from "./policy.js";

const share = z.enum(["majority", "two-thirds", "three-quarters"]);

const punishment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cooloff"), minutes: z.number().int().positive() }),
  z.object({ type: z.literal("warn") }),
  z.object({ type: z.literal("timeout"), minutes: z.number().int().positive().max(28 * 24 * 60) }),
  z.object({ type: z.literal("kick") }),
  z.object({ type: z.literal("ban"), days: z.number().int().positive().nullable() }),
]);

const step = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(40),
  level: z.number().int().min(1).nullable(),
  punishment,
  yes: z.number().int().min(1),
  share,
  windowMinutes: z.number().int().min(1).max(32 * 24 * 60),
  witnessYes: z.number().int().min(0),
  closeOnThreshold: z.boolean(),
  retryAfterFailMinutes: z.number().int().min(0),
});

const voteRule = { yes: z.number().int().min(1), share, windowMinutes: z.number().int().min(1) };

export const policySchema = z.object({
  memberMinDays: z.number().min(0),
  strikeWindowDays: z.number().positive(),
  decayDays: z.number().positive(),
  involvementDays: z.number().min(0),
  retaliationLockHours: z.number().min(0),
  witnessWindowMinutes: z.number().positive(),
  voiceRetentionDays: z.number().positive(),
  breaker: z.object({ maxCasesPerHour: z.number().int().positive(), pauseMinutes: z.number().int().positive() }),
  memberSteps: z.array(step).min(1),
  newcomerSteps: z.array(step).min(1),
  noContact: z.object({ ...voteRule, days: z.number().positive(), retryAfterFailMinutes: z.number().int().min(0) }),
  appeal: z.object({
    ...voteRule,
    afterFractionOfBan: z.number().min(0).max(1),
    permanentAfterDays: z.number().min(0),
    retryAfterFailDays: z.number().min(0),
  }),
});

export const configSchema = z.object({
  /** Bot token. Prefer the DISCORD_TOKEN environment variable; this is a fallback. */
  token: z.string().min(1).optional(),
  /** Application (client) id from the Developer Portal. */
  applicationId: z.string().regex(/^\d+$/),
  /** The one server this bot serves. */
  guildId: z.string().regex(/^\d+$/),
  /** Where vote cards are posted. Members need to be able to see and press buttons here. */
  courtChannelId: z.string().regex(/^\d+$/),
  /** Where results and the audit trail go. Can be the same channel. */
  logChannelId: z.string().regex(/^\d+$/),
  /** Record everything, act on nothing. Start here. */
  shadow: z.boolean().default(true),
  /** Short names for the server rules, shown as a menu when filing. */
  rules: z.array(z.string().min(1).max(100)).max(25).default(["Be decent to each other", "No spam", "No slurs or harassment", "Keep it legal"]),
  databasePath: z.string().default("data/tribunal.db"),
  /** Deep merged over the defaults in src/policy.ts. */
  policy: policySchema.partial().default({}),
});

export type Config = Omit<z.infer<typeof configSchema>, "policy"> & { policy: Policy };

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(raw);
  const policy: Policy = policySchema.parse({ ...DEFAULT_POLICY, ...parsed.policy });
  const stepIds = new Set([...policy.memberSteps, ...policy.newcomerSteps].map((s) => s.id));
  if (!stepIds.has("cooloff")) throw new Error("policy needs a step with id \"cooloff\" on at least one track");
  const token = env.DISCORD_TOKEN ?? parsed.token;
  if (!token) throw new Error("set DISCORD_TOKEN in the environment or \"token\" in config.json");
  return { ...parsed, token, policy };
}

export function loadConfig(path = process.env.TRIBUNAL_CONFIG ?? "config.json"): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`could not read ${path}. Copy config.example.json to config.json and fill it in.`);
  }
  return parseConfig(JSON.parse(text));
}
