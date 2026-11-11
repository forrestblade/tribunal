import { describe, expect, it } from "vitest";
import { witnessesOf, type Session } from "../src/engine/witness.js";

const MIN = 60_000;
const s = (userId: string, channelId: string, joined: number, left: number | null): Session => ({ userId, channelId, joinedAt: joined * MIN, leftAt: left === null ? null : left * MIN });

describe("witnessesOf", () => {
  it("finds people who overlapped with the target in the same channel inside the window", () => {
    const sessions = [
      s("T", "vc1", 0, null),
      s("A", "vc1", 10, null),
      s("B", "vc1", 0, 5),
      s("C", "vc2", 0, null),
      s("D", "vc1", 61, null),
    ];
    const w = witnessesOf("T", sessions, 30 * MIN, 60 * MIN);
    expect([...w].sort()).toEqual(["A"]);
  });
  it("counts overlaps across channel moves", () => {
    const sessions = [s("T", "vc1", 0, 20), s("T", "vc2", 20, null), s("A", "vc2", 25, 40)];
    expect([...witnessesOf("T", sessions, 0, 60 * MIN)]).toEqual(["A"]);
  });
  it("ignores touching but not overlapping sessions", () => {
    const sessions = [s("T", "vc1", 0, 20), s("A", "vc1", 20, 30)];
    expect(witnessesOf("T", sessions, 0, 60 * MIN).size).toBe(0);
  });
});
