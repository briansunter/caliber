/** Limit retained values by both entry count and their measured byte size. */
export class ByteLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; bytes: number }>();
  private retainedBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    )
      throw new RangeError("Invalid cache capacity");
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retainedBytes -= entry.bytes;
    this.entries.delete(key);
  }

  set(key: K, value: V, bytes: number): void {
    this.delete(key);
    // A large archive can still satisfy the current request without being
    // kept alive in the cache afterward.
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) return;
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBytes)
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, bytes });
    this.retainedBytes += bytes;
  }
}
