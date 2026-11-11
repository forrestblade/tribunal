import { describe, expect, it } from "vitest";
import { decide, meets, type Requirement } from "../src/engine/tally.js";
import { shareMet } from "../src/policy.js";

const req = (r: Partial<Requirement> = {}): Requirement => ({
  yes: 4,
  share: "two-thirds",
  witnessYes: 0,
  closeOnThreshold: false,
  ...r,
});
const count = (yes: number, no: number, remaining: number, witnessYes = 0, witnessRemaining = 0) => ({
  yes,
  no,
  remaining,
  witnessYes,
  witnessRemaining,
});

describe("shareMet", () => {
  it("majority is strictly more yes than no", () => {
    expect(shareMet("majority", 3, 2)).toBe(true);
    expect(shareMet("majority", 3, 3)).toBe(false);
  });
  it("two-thirds and three-quarters include the boundary", () => {
    expect(shareMet("two-thirds", 4, 2)).toBe(true);
    expect(shareMet("two-thirds", 5, 3)).toBe(false);
    expect(shareMet("three-quarters", 6, 2)).toBe(true);
    expect(shareMet("three-quarters", 8, 3)).toBe(false);
  });
  it("needs at least one vote", () => {
    expect(shareMet("majority", 0, 0)).toBe(false);
  });
});

describe("meets", () => {
  it("needs the count, the share and the witnesses", () => {
    expect(meets(req(), 4, 2, 0)).toBe(true);
    expect(meets(req(), 3, 0, 0)).toBe(false);
    expect(meets(req(), 4, 3, 0)).toBe(false);
    expect(meets(req({ witnessYes: 2 }), 4, 0, 1)).toBe(false);
    expect(meets(req({ witnessYes: 2 }), 4, 0, 2)).toBe(true);
  });
});

describe("decide", () => {
  it("stays open while the outcome can change", () => {
    expect(decide(req(), count(2, 0, 10), false)).toBe("open");
    expect(decide(req(), count(4, 0, 10), false)).toBe("open");
  });
  it("passes early only when the remaining voters cannot overturn it", () => {
    expect(decide(req(), count(8, 0, 4), false)).toBe("pass");
    expect(decide(req(), count(8, 0, 5), false)).toBe("open");
  });
  it("fails early when even a full yes turnout cannot reach the bar", () => {
    expect(decide(req(), count(1, 0, 2), false)).toBe("fail");
    // 3/4 with 4 no needs 12 yes: 11 remaining cannot get there, 12 can.
    expect(decide(req({ share: "three-quarters" }), count(0, 4, 11), false)).toBe("fail");
    expect(decide(req({ share: "three-quarters" }), count(0, 4, 12), false)).toBe("open");
  });
  it("fails early when not enough witnesses are left", () => {
    expect(decide(req({ witnessYes: 2 }), count(1, 0, 10, 0, 1), false)).toBe("fail");
    expect(decide(req({ witnessYes: 2 }), count(1, 0, 10, 0, 2), false)).toBe("open");
  });
  it("cool-offs pass the moment the threshold is met", () => {
    const cool = req({ yes: 3, share: "majority", closeOnThreshold: true });
    expect(decide(cool, count(3, 0, 20), false)).toBe("pass");
    expect(decide(cool, count(3, 3, 20), false)).toBe("open");
  });
  it("at the deadline it is pass or fail, never open", () => {
    expect(decide(req(), count(4, 2, 10), true)).toBe("pass");
    expect(decide(req(), count(3, 0, 10), true)).toBe("fail");
  });
});
