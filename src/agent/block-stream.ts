export const BLOCK_STREAM_TICK_MS = 16;
export const BLOCK_STREAM_CATCH_UP_LINES = 8;
export const BLOCK_STREAM_CATCH_UP_AGE_MS = 120;

type QueuedBlock = {
  text: string;
  enqueuedAt: number;
};

export class BlockStreamBuffer {
  private pending = '';
  private readonly queue: QueuedBlock[] = [];

  push(delta: string, now = Date.now()) {
    if (!delta) return false;
    this.pending += delta;

    let blockStart = 0;
    let newlineIndex = this.pending.indexOf('\n', blockStart);
    while (newlineIndex !== -1) {
      this.queue.push({
        text: this.pending.slice(blockStart, newlineIndex + 1),
        enqueuedAt: now,
      });
      blockStart = newlineIndex + 1;
      newlineIndex = this.pending.indexOf('\n', blockStart);
    }
    if (blockStart === 0) return false;
    this.pending = this.pending.slice(blockStart);
    return true;
  }

  drain(now = Date.now()) {
    if (this.queue.length === 0) return '';
    const oldestAge = Math.max(0, now - this.queue[0].enqueuedAt);
    const catchUp = this.queue.length >= BLOCK_STREAM_CATCH_UP_LINES || oldestAge >= BLOCK_STREAM_CATCH_UP_AGE_MS;
    const count = catchUp ? this.queue.length : 1;
    return this.queue
      .splice(0, count)
      .map(block => block.text)
      .join('');
  }

  finalize() {
    const text = `${this.queue.map(block => block.text).join('')}${this.pending}`;
    this.clear();
    return text;
  }

  hasQueuedBlocks() {
    return this.queue.length > 0;
  }

  clear() {
    this.pending = '';
    this.queue.length = 0;
  }
}

export class BlockStreamPump {
  private readonly buffer = new BlockStreamBuffer();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly commit: (text: string) => void) {}

  push(delta: string) {
    if (this.buffer.push(delta)) this.schedule();
  }

  flush() {
    this.cancelTimer();
    const text = this.buffer.finalize();
    if (text) this.commit(text);
  }

  dispose() {
    this.cancelTimer();
    this.buffer.clear();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const text = this.buffer.drain();
      if (text) this.commit(text);
      if (this.buffer.hasQueuedBlocks()) this.schedule();
    }, BLOCK_STREAM_TICK_MS);
    this.timer.unref?.();
  }

  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
