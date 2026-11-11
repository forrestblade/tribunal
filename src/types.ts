import type { Requirement } from "./engine/tally.js";
import type { Track } from "./policy.js";

export type CaseKind = "sanction" | "nocontact" | "appeal";
export type CaseStatus = "open" | "passed" | "failed";
/** Cases in different lanes can run side by side; one open case per person per lane. */
export type Lane = "cooloff" | "regular" | "nocontact" | "appeal";
export type VoteValue = "yes" | "no";

export interface Evidence {
  url: string | null;
  authorId: string | null;
  /** Copied when the case is filed, so deleting the message does not delete the evidence. */
  content: string | null;
  attachments: { name: string; url: string; size: number }[];
}

export interface CaseRecord {
  id: number;
  kind: CaseKind;
  /** Which ladder the target was on when the case was filed. null for no-contact and appeals. */
  track: Track | null;
  /** Step id for sanctions. null otherwise. */
  stepId: string | null;
  /** The accused, party A of a no-contact order, or the banned user an appeal is for. */
  targetId: string;
  /** Party B of a no-contact order. */
  partyBId: string | null;
  proposerId: string;
  rule: string | null;
  reason: string;
  voice: boolean;
  evidence: Evidence | null;
  /** Everyone allowed to vote, fixed when the case is filed. */
  electorate: string[];
  /** Everyone who shared voice with the target before the case. Empty unless voice. */
  witnesses: string[];
  requirement: Requirement;
  /** Target's ladder level when filed, for display. */
  targetLevel: number | null;
  filedAt: number;
  closesAt: number;
  status: CaseStatus;
  closedAt: number | null;
  shadow: boolean;
  /** For appeals: the case that imposed the ban. */
  appealOf: number | null;
  channelId: string | null;
  messageId: string | null;
  threadId: string | null;
}

export type NewCase = Omit<CaseRecord, "id" | "status" | "closedAt" | "channelId" | "messageId" | "threadId">;

export interface VoteRecord {
  caseId: number;
  voterId: string;
  value: VoteValue;
  castAt: number;
}

export interface StrikeRecord {
  id: number;
  userId: string;
  caseId: number;
  level: number;
  imposedAt: number;
  endsAt: number | null;
  voided: boolean;
  shadow: boolean;
}

export interface BanRecord {
  userId: string;
  caseId: number;
  imposedAt: number;
  /** null for permanent. */
  until: number | null;
  liftedAt: number | null;
  shadow: boolean;
}

export interface NoContactRecord {
  id: number;
  caseId: number;
  aId: string;
  bId: string;
  until: number;
  shadow: boolean;
}

export type ScheduledKind = "unban" | "unmute";

export interface ScheduledRecord {
  id: number;
  kind: ScheduledKind;
  userId: string;
  caseId: number;
  dueAt: number;
}

/** Things that could not be done because the person was away; applied when they come back. */
export type PendingKind = "timeout" | "unmute";

export interface PendingRecord {
  id: number;
  kind: PendingKind;
  userId: string;
  caseId: number;
  minutes: number | null;
  createdAt: number;
}

export interface StatementRecord {
  caseId: number;
  userId: string;
  text: string;
  at: number;
}

export function laneOf(c: Pick<CaseRecord, "kind" | "stepId">): Lane {
  if (c.kind === "nocontact") return "nocontact";
  if (c.kind === "appeal") return "appeal";
  return c.stepId === "cooloff" ? "cooloff" : "regular";
}
