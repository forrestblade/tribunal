// Short-lived state between two steps of filing: the words after "@bot @them",
// waiting for the author to press the button, and evidence copied from a
// right-clicked message, waiting for its form to be submitted.
import { TtlMap } from "../ttl-map.js";
import type { Evidence } from "../types.js";
import type { MessageRef } from "./custom-ids.js";

const DRAFT_TTL = 15 * 60_000;

export interface DraftReason {
  authorId: string;
  reason: string;
}

export class Drafts {
  /** Keyed by the id of the bot's reply that carries the button. */
  readonly reasons: TtlMap<string, DraftReason>;
  /** Keyed by channel:message. */
  private readonly evidence: TtlMap<string, Evidence>;

  constructor(now: () => number = Date.now) {
    this.reasons = new TtlMap(DRAFT_TTL, now);
    this.evidence = new TtlMap(DRAFT_TTL, now);
  }

  keepEvidence(e: Evidence): MessageRef {
    this.evidence.set(`${e.channelId}:${e.messageId}`, e);
    return { channelId: e.channelId, messageId: e.messageId };
  }

  takeEvidence(ref: MessageRef): Evidence | undefined {
    return this.evidence.take(`${ref.channelId}:${ref.messageId}`);
  }

  sweep(): void {
    this.reasons.sweep();
    this.evidence.sweep();
  }
}
