import { describe, expect, it } from "vitest";
import { decodeCustomId, encodeCustomId, type CustomId } from "../src/discord/custom-ids.js";
import { clip, formatMinutes, plural, when } from "../src/format.js";
import { TtlMap } from "../src/ttl-map.js";

describe("custom ids", () => {
  const cases: CustomId[] = [
    { kind: "vote", caseId: 12, value: "yes" },
    { kind: "vote", caseId: 12, value: "no" },
    { kind: "statement", caseId: 7 },
    { kind: "open", targetId: "123", evidence: null },
    { kind: "open", targetId: "123", evidence: { channelId: "456", messageId: "789" } },
    { kind: "file", targetId: "123", evidence: null },
    { kind: "file", targetId: "123", evidence: { channelId: "456", messageId: "789" } },
  ];

  it("round-trips every shape", () => {
    for (const id of cases) expect(decodeCustomId(encodeCustomId(id))).toEqual(id);
  });

  it("stays under Discord's 100 character limit with snowflakes", () => {
    const long = "9".repeat(20);
    const id = encodeCustomId({ kind: "file", targetId: long, evidence: { channelId: long, messageId: long } });
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("rejects garbage", () => {
    expect(decodeCustomId("vote:abc:yes")).toBeNull();
    expect(decodeCustomId("vote:1:maybe")).toBeNull();
    expect(decodeCustomId("statement:x")).toBeNull();
    expect(decodeCustomId("open:")).toBeNull();
    expect(decodeCustomId("nope")).toBeNull();
  });
});

describe("TtlMap", () => {
  it("expires entries and sweeps them", () => {
    let now = 0;
    const m = new TtlMap<string, number>(100, () => now);
    m.set("a", 1);
    expect(m.get("a")).toBe(1);
    now = 100;
    expect(m.get("a")).toBeUndefined();
    m.set("b", 2);
    now = 150;
    expect(m.size).toBe(1);
    now = 250;
    expect(m.size).toBe(0);
  });

  it("take removes on read", () => {
    const m = new TtlMap<string, number>(100, () => 0);
    m.set("a", 1);
    expect(m.take("a")).toBe(1);
    expect(m.take("a")).toBeUndefined();
  });
});

describe("format", () => {
  it("renders Discord timestamps in seconds", () => {
    expect(when(1_700_000_000_123)).toBe("<t:1700000000:f>");
    expect(when(1_700_000_000_123, "R")).toBe("<t:1700000000:R>");
  });

  it("formats durations the way people say them", () => {
    expect(formatMinutes(10)).toBe("10 min");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(1440)).toBe("1 day");
    expect(formatMinutes(7 * 1440)).toBe("7 days");
  });

  it("clips and pluralises", () => {
    expect(clip("hello", 10)).toBe("hello");
    expect(clip("hello world", 6)).toBe("hello…");
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(3, "person", "people")).toBe("3 people");
    expect(plural(2, "vote")).toBe("2 votes");
  });
});
