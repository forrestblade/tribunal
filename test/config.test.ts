import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { DEFAULT_POLICY } from "../src/policy.js";

const base = { applicationId: "1", guildId: "2", courtChannelId: "3", logChannelId: "4" };

describe("parseConfig", () => {
  it("fills defaults and reads the token from the environment", () => {
    const c = parseConfig(base, { DISCORD_TOKEN: "t" });
    expect(c.token).toBe("t");
    expect(c.shadow).toBe(true);
    expect(c.policy).toEqual(DEFAULT_POLICY);
    expect(c.rules.length).toBeGreaterThan(0);
  });

  it("merges policy overrides over the defaults", () => {
    const c = parseConfig({ ...base, policy: { memberMinDays: 30 } }, { DISCORD_TOKEN: "t" });
    expect(c.policy.memberMinDays).toBe(30);
    expect(c.policy.memberSteps).toEqual(DEFAULT_POLICY.memberSteps);
  });

  it("rejects timeouts over 28 days and missing tokens", () => {
    const steps = [{ ...DEFAULT_POLICY.memberSteps[2]!, punishment: { type: "timeout", minutes: 29 * 24 * 60 } }];
    expect(() => parseConfig({ ...base, policy: { memberSteps: steps } }, { DISCORD_TOKEN: "t" })).toThrow();
    expect(() => parseConfig(base, {})).toThrow("DISCORD_TOKEN");
  });

  it("accepts the example config", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
    expect(() => parseConfig(raw, { DISCORD_TOKEN: "t" })).not.toThrow();
  });
});
