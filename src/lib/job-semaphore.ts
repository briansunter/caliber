/** Keep archive work bounded and hand released slots directly to queued jobs. */
export class JobSemaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("Invalid concurrency limit");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.max) {
      this.running += 1;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
