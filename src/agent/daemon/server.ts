import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';

import type { AgentDaemonInbound, AgentDaemonOutbound, SharedRootSnapshot } from './protocol';

export function agentsSocketPath(yetHome = join(homedir(), '.yet')) {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\yet-agents'
    : join(yetHome, 'agents.sock');
}

function write(socket: Socket, message: AgentDaemonOutbound) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function socketIsLive(path: string) {
  return new Promise<boolean>(resolve => {
    const socket = connect(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function acquireDaemonLock(socketPath: string) {
  if (process.platform === 'win32') return null;
  const lockPath = `${socketPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      return { handle, lockPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await socketIsLive(socketPath)) throw new Error('agents daemon is already running');
      const pid = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      let ownerAlive = false;
      if (Number.isFinite(pid)) {
        try { process.kill(pid, 0); ownerAlive = true; } catch {}
      }
      if (ownerAlive) throw new Error('agents daemon is already starting');
      await rm(lockPath, { force: true });
    }
  }
  throw new Error('could not acquire the agents daemon lock');
}

export async function runAgentsDaemon(options: { yetHome?: string } = {}) {
  const socketPath = agentsSocketPath(options.yetHome);
  const roots = new Map<string, { snapshot: SharedRootSnapshot; socket: Socket }>();
  const pending = new Map<string, { requester: Socket; owner: Socket; originalRequestId: string }>();
  const connections = new Set<Socket>();
  let daemonLock: Awaited<ReturnType<typeof acquireDaemonLock>> = null;

  if (process.platform !== 'win32') {
    await mkdir(dirname(socketPath), { recursive: true });
    if (await socketIsLive(socketPath)) throw new Error('agents daemon is already running');
    daemonLock = await acquireDaemonLock(socketPath);
    await rm(socketPath, { force: true });
  }

  const server = createServer(socket => {
    connections.add(socket);
    let buffer = '';
    let registeredRootId: string | null = null;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!raw.trim()) continue;
        let message: AgentDaemonInbound;
        try { message = JSON.parse(raw) as AgentDaemonInbound; } catch { continue; }

        if (message.type === 'register' || message.type === 'update') {
          registeredRootId = message.snapshot.rootId;
          roots.set(message.snapshot.rootId, { snapshot: message.snapshot, socket });
          if (message.type === 'register') write(socket, { type: 'registered' });
          continue;
        }
        if (message.type === 'list') {
          write(socket, {
            type: 'list_result',
            requestId: message.requestId,
            roots: [...roots.values()]
              .map(value => value.snapshot)
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          });
          continue;
        }
        if (message.type === 'command') {
          const owner = roots.get(message.command.rootId);
          if (!owner || owner.socket.destroyed) {
            write(socket, { type: 'command_result', requestId: message.requestId, ok: false, error: 'root session is offline' });
            continue;
          }
          const forwardId = `${message.requestId}:${Date.now()}:${Math.random()}`;
          pending.set(forwardId, { requester: socket, owner: owner.socket, originalRequestId: message.requestId });
          write(owner.socket, { type: 'command', requestId: forwardId, command: message.command });
          continue;
        }
        if (message.type === 'command_result') {
          const request = pending.get(message.requestId);
          if (!request) continue;
          pending.delete(message.requestId);
          write(request.requester, {
            type: 'command_result',
            requestId: request.originalRequestId,
            ok: message.ok,
            ...(message.error ? { error: message.error } : {}),
          });
        }
      }
    });
    socket.on('close', () => {
      connections.delete(socket);
      if (registeredRootId && roots.get(registeredRootId)?.socket === socket) roots.delete(registeredRootId);
      for (const [id, request] of pending) {
        if (request.requester === socket) {
          pending.delete(id);
          continue;
        }
        if (request.owner === socket) {
          pending.delete(id);
          write(request.requester, {
            type: 'command_result',
            requestId: request.originalRequestId,
            ok: false,
            error: 'root session went offline',
          });
        }
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await daemonLock?.handle.close().catch(() => {});
    if (daemonLock) await rm(daemonLock.lockPath, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') await chmod(socketPath, 0o600).catch(() => {});
  let closing: Promise<void> | null = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (process.platform !== 'win32') await rm(socketPath, { force: true });
      await daemonLock?.handle.close().catch(() => {});
      if (daemonLock) await rm(daemonLock.lockPath, { force: true });
    })();
    return closing;
  };
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  return { server, close, socketPath };
}
