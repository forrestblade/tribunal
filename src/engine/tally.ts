import { shareMet, type Share } from "../policy.js";

/** What a case needs to pass, frozen into the case when it is filed. */
export interface Requirement {
  yes: number;
  share: Share;
  /** Yes votes that must come from voice witnesses. 0 when the case is not about voice. */
  witnessYes: number;
  closeOnThreshold: boolean;
}

export interface Count {
  yes: number;
  no: number;
  witnessYes: number;
  /** Eligible voters who have not voted yet. */
  remaining: number;
  /** Of those, how many are witnesses. */
  witnessRemaining: number;
}

export type Decision = "pass" | "fail" | "open";

export function meets(req: Requirement, yes: number, no: number, witnessYes: number): boolean {
  return yes >= req.yes && shareMet(req.share, yes, no) && witnessYes >= req.witnessYes;
}

/**
 * Decide a case. Before the deadline a case closes early only when the outcome
 * can no longer change: it passes if it would still pass with every remaining
 * voter voting no, and fails if it could not pass with every remaining voter
 * voting yes. Cool-offs pass the moment the threshold is met.
 */
export function decide(req: Requirement, c: Count, final: boolean): Decision {
  if (final) return meets(req, c.yes, c.no, c.witnessYes) ? "pass" : "fail";
  if (req.closeOnThreshold && meets(req, c.yes, c.no, c.witnessYes)) return "pass";
  if (meets(req, c.yes, c.no + c.remaining, c.witnessYes)) return "pass";
  if (!meets(req, c.yes + c.remaining, c.no, c.witnessYes + c.witnessRemaining)) return "fail";
  return "open";
}
