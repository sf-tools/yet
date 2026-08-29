import { randomUUID } from 'node:crypto';

export type MailboxEnvelopeKind = 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER';

export type MailboxEnvelope = {
  id: string;
  kind: MailboxEnvelopeKind;
  from: string;
  to: string;
  message: string;
  triggerTurn: boolean;
  createdAt: string;
};

type Waiter = {
  resolve: (value: MailboxEnvelope[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

export class AgentMailbox {
  private readonly queue: MailboxEnvelope[] = [];
  private readonly waiters = new Set<Waiter>();

  constructor(initial: MailboxEnvelope[] = []) {
    this.queue.push(...initial.map(envelope => ({ ...envelope })));
  }

  enqueue(input: Omit<MailboxEnvelope, 'id' | 'createdAt'> & Partial<Pick<MailboxEnvelope, 'id' | 'createdAt'>>) {
    const envelope: MailboxEnvelope = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.queue.push(envelope);
    this.flushWaiters();
    return envelope;
  }

  hasPending() {
    return this.queue.length > 0;
  }

  pending() {
    return this.queue.map(envelope => ({ ...envelope }));
  }

  takeAll() {
    return this.queue.splice(0, this.queue.length);
  }

  remove(id: string) {
    const index = this.queue.findIndex(envelope => envelope.id === id);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  takeTriggered() {
    const triggered = this.queue.filter(envelope => envelope.triggerTurn);
    if (triggered.length === 0) return [];
    const ids = new Set(triggered.map(envelope => envelope.id));
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.queue[index].id)) this.queue.splice(index, 1);
    }
    return triggered;
  }

  wake() {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.abort?.();
      waiter.resolve([]);
    }
    this.waiters.clear();
  }

  wait(timeoutMs: number, signal?: AbortSignal) {
    if (this.queue.length > 0) return Promise.resolve(this.pending());
    return new Promise<MailboxEnvelope[] | null>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          waiter.abort?.();
          resolve(null);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      if (signal) {
        const onAbort = () => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.abort = () => signal.removeEventListener('abort', onAbort);
      }
      this.waiters.add(waiter);
    });
  }

  private flushWaiters() {
    if (this.queue.length === 0) return;
    const pending = this.pending();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.abort?.();
      waiter.resolve(pending);
    }
    this.waiters.clear();
  }
}

export function formatMailboxEnvelope(envelope: MailboxEnvelope) {
  return `Message Type: ${envelope.kind}\nTask name: ${envelope.to}\nSender: ${envelope.from}\nPayload:\n${envelope.message}`;
}
