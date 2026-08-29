import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';

import { agentsSocketPath } from './server';
import type {
  AgentDaemonCommand,
  AgentDaemonInbound,
  AgentDaemonOutbound,
  SharedRootSnapshot,
} from './protocol';

function executableInvocation() {
  const script = process.argv[1];
  return script
    ? { command: process.execPath, args: [script, '__agents-daemon'] }
    : null;
}

function openSocket(path: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(path);
    const onConnect = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

async function ensureDaemon(path: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const socket = await openSocket(path);
      socket.destroy();
      return;
    } catch {
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (path !== agentsSocketPath()) throw new Error(`agents daemon is unavailable at ${path}`);
  const invocation = executableInvocation();
  if (!invocation) throw new Error('cannot locate the Yet executable for the agents daemon');
  const child = spawn(invocation.command, [...invocation.args], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 2_500) {
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      const socket = await openSocket(path);
      socket.destroy();
      return;
    } catch {}
  }
  throw new Error('agents daemon did not start');
}

function write(socket: Socket, message: AgentDaemonInbound) {
  socket.write(`${JSON.stringify(message)}\n`);
}

export class AgentDaemonClient {
  private socket: Socket | null = null;
  private buffer = '';
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private registration: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private snapshot: SharedRootSnapshot,
    private readonly onCommand: (command: AgentDaemonCommand) => Promise<void>,
    private readonly socketPath = agentsSocketPath(),
  ) {}

  async connect() {
    this.closed = false;
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return await this.connecting;
    const connecting = this.connectOnce();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  private async connectOnce() {
    await ensureDaemon(this.socketPath);
    const socket = await openSocket(this.socketPath);
    if (this.closed) {
      socket.destroy();
      throw new Error('agents daemon client is closed');
    }
    this.socket = socket;
    this.buffer = '';
    let registeredConnection = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.onData(String(chunk)));
    socket.on('error', () => {
      // The close event below owns reconnect and registration cleanup.
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.closed && registeredConnection) this.scheduleReconnect();
    });
    const registered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agents daemon registration timed out')), 2_500);
      timer.unref?.();
      this.registration = { resolve, reject, timer };
    });
    const failRegistration = (error?: Error) => {
      if (!this.registration) return;
      clearTimeout(this.registration.timer);
      this.registration.reject(error ?? new Error('agents daemon disconnected during registration'));
      this.registration = null;
    };
    socket.once('error', failRegistration);
    socket.once('close', failRegistration);
    write(socket, { type: 'register', snapshot: this.snapshot });
    try {
      await registered;
      registeredConnection = true;
    } catch (error) {
      socket.destroy();
      if (this.socket === socket) this.socket = null;
      throw error;
    } finally {
      socket.off('error', failRegistration);
      socket.off('close', failRegistration);
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, 250);
    this.reconnectTimer.unref?.();
  }

  update(snapshot: SharedRootSnapshot) {
    this.snapshot = snapshot;
    if (this.socket && !this.socket.destroyed) write(this.socket, { type: 'update', snapshot });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.registration) {
      clearTimeout(this.registration.timer);
      this.registration.reject(new Error('agents daemon client closed during registration'));
      this.registration = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message: AgentDaemonOutbound;
      try { message = JSON.parse(raw) as AgentDaemonOutbound; } catch { continue; }
      if (message.type === 'registered') {
        if (this.registration) {
          clearTimeout(this.registration.timer);
          this.registration.resolve();
          this.registration = null;
        }
        continue;
      }
      if (message.type !== 'command') continue;
      void this.onCommand(message.command).then(
        () => this.socket && write(this.socket, { type: 'command_result', requestId: message.requestId, ok: true }),
        error => this.socket && write(this.socket, {
          type: 'command_result', requestId: message.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function request<T extends AgentDaemonOutbound>(
  message: AgentDaemonInbound,
  expectedType: T['type'],
  socketPath = agentsSocketPath(),
) {
  await ensureDaemon(socketPath);
  const socket = await openSocket(socketPath);
  return await new Promise<T>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('agents daemon request timed out')));
    }, 5_000);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response: AgentDaemonOutbound;
      try {
        response = JSON.parse(buffer.slice(0, newline)) as AgentDaemonOutbound;
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (response.type !== expectedType) {
        finish(() => reject(new Error(`unexpected agents daemon response: ${response.type}`)));
      } else {
        finish(() => resolve(response as T));
      }
    });
    socket.once('error', error => finish(() => reject(error)));
    write(socket, message);
  });
}

export async function listSharedAgents(socketPath = agentsSocketPath()) {
  const requestId = randomUUID();
  const response = await request<Extract<AgentDaemonOutbound, { type: 'list_result' }>>(
    { type: 'list', requestId }, 'list_result', socketPath,
  );
  return response.roots;
}

export async function sendSharedAgentCommand(command: AgentDaemonCommand, socketPath = agentsSocketPath()) {
  const requestId = randomUUID();
  const response = await request<Extract<AgentDaemonOutbound, { type: 'command_result' }>>(
    { type: 'command', requestId, command }, 'command_result', socketPath,
  );
  if (!response.ok) throw new Error(response.error ?? 'agents command failed');
}
