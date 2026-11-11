export interface Session {
  userId: string;
  channelId: string;
  joinedAt: number;
  /** null while still connected. */
  leftAt: number | null;
}

/**
 * Everyone who shared a voice channel with the target at some point in
 * [from, to]. Two sessions overlap when they are in the same channel and their
 * time ranges intersect inside the window.
 */
export function witnessesOf(targetId: string, sessions: Session[], from: number, to: number): Set<string> {
  const mine = sessions.filter((s) => s.userId === targetId);
  const out = new Set<string>();
  for (const other of sessions) {
    if (other.userId === targetId || out.has(other.userId)) continue;
    for (const t of mine) {
      if (t.channelId !== other.channelId) continue;
      const start = Math.max(t.joinedAt, other.joinedAt, from);
      const end = Math.min(t.leftAt ?? to, other.leftAt ?? to, to);
      if (start < end) {
        out.add(other.userId);
        break;
      }
    }
  }
  return out;
}
