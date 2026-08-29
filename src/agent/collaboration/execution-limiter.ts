export class AgentExecutionLimiter {
  private active = 0;

  constructor(readonly maxActive: number) {}

  get activeCount() {
    return this.active;
  }

  hasCapacity() {
    return this.active < this.maxActive;
  }

  acquire() {
    if (!this.hasCapacity()) {
      throw new Error(`maximum number of active agents reached (${this.maxActive})`);
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}
