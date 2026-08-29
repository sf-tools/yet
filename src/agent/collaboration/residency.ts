export class AgentResidency {
  private readonly residents: string[] = [];

  constructor(readonly capacity: number) {}

  list() {
    return [...this.residents];
  }

  touch(agentId: string) {
    const index = this.residents.indexOf(agentId);
    if (index !== -1) this.residents.splice(index, 1);
    this.residents.push(agentId);
  }

  remove(agentId: string) {
    const index = this.residents.indexOf(agentId);
    if (index !== -1) this.residents.splice(index, 1);
  }

  async reserve(options: {
    protectedAgentId?: string;
    canUnload: (agentId: string) => boolean;
    unload: (agentId: string) => Promise<void>;
  }) {
    if (this.residents.length < this.capacity) return;
    const attempts = this.residents.length;
    for (let count = 0; count < attempts; count += 1) {
      const candidate = this.residents.shift();
      if (!candidate) break;
      if (candidate === options.protectedAgentId || !options.canUnload(candidate)) {
        this.residents.push(candidate);
        continue;
      }
      await options.unload(candidate);
      return;
    }
    throw new Error(`maximum number of resident agents reached (${this.capacity})`);
  }
}
