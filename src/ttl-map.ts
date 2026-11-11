/** A map whose entries expire. Expired entries are dropped on read and on sweep(). */
export class TtlMap<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  set(key: K, value: V): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Read and remove in one step. */
  take(key: K): V | undefined {
    const value = this.get(key);
    this.entries.delete(key);
    return value;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }
}
