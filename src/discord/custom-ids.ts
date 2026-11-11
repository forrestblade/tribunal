// Button and modal custom ids, encoded and decoded in one place. Discord caps them at 100 characters.
import type { VoteValue } from "../types.js";

export type CustomId =
  | { kind: "vote"; caseId: number; value: VoteValue }
  | { kind: "statement"; caseId: number }
  /** The button under a "@bot @them ..." reply; opens the filing form. */
  | { kind: "open"; targetId: string; evidence: MessageRef | null }
  /** The filing form itself. */
  | { kind: "file"; targetId: string; evidence: MessageRef | null };

export interface MessageRef {
  channelId: string;
  messageId: string;
}

const NONE = "-";

export function encodeCustomId(id: CustomId): string {
  switch (id.kind) {
    case "vote":
      return `vote:${id.caseId}:${id.value}`;
    case "statement":
      return `statement:${id.caseId}`;
    case "open":
    case "file":
      return `${id.kind}:${id.targetId}:${id.evidence?.channelId ?? NONE}:${id.evidence?.messageId ?? NONE}`;
  }
}

export function decodeCustomId(raw: string): CustomId | null {
  const [kind, a, b, c] = raw.split(":");
  switch (kind) {
    case "vote": {
      const caseId = Number(a);
      if (!Number.isInteger(caseId) || (b !== "yes" && b !== "no")) return null;
      return { kind, caseId, value: b };
    }
    case "statement": {
      const caseId = Number(a);
      return Number.isInteger(caseId) ? { kind, caseId } : null;
    }
    case "open":
    case "file": {
      if (!a) return null;
      const evidence = b && b !== NONE && c && c !== NONE ? { channelId: b, messageId: c } : null;
      return { kind, targetId: a, evidence };
    }
    default:
      return null;
  }
}
