/**
 * server/game-server.ts —— WSS 权威模拟服务器（阶段④）。
 *
 * 架构（技术规格）：服务器持权威 Sim；客户端只收快照 + 上行命令。
 *  - tick 循环：固定 100ms 步长（dt=0.1；衰减/速度都是每秒速率，确定性不受步长影响）。
 *  - 同步节奏：增量 ~500ms（只发改变的 pawn + 删除名单 + 新事件），全量对账 ~5000ms，
 *    新连接先收 welcome（seed+tuning+全量）。
 *  - 命令上行：白名单（SERVER_COMMANDS）+ 参数校验 → issueCommand 同一入口；
 *    非法命令静默丢弃并计数（防注入面，不给客户端错误回显通道）。
 *
 * 可测试性：createGameServer 接受端口或现成 http.Server（测试用 ephemeral 端口），
 * 返回句柄可 dispose；sim 引用暴露给测试直接断言世界状态。
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Sim } from '../sim';
import type { ModRegistry } from '../mods';
import type { FullState, ServerMsg } from '../shared/protocol';
import { SERVER_COMMANDS, validMoveArgs } from '../shared/protocol';

export interface GameServerOptions {
  port?: number;
  seed?: number;
  registry: ModRegistry;
  /** 现成 http.Server（测试/反代场景）；不给就自建 */
  httpServer?: HttpServer;
  tickMs?: number;
  deltaMs?: number;
  fullMs?: number;
}

export interface GameServerHandle {
  sim: Sim;
  port: number;
  clientCount(): number;
  rejectedCommands(): number;
  close(): Promise<void>;
}

interface ClientCtx {
  sock: WebSocket;
  lastPawnJson: Map<string, string>;
  sentEvents: number;
}

export function createGameServer(opts: GameServerOptions): Promise<GameServerHandle> {
  const sim = new Sim({ seed: opts.seed ?? 42, registry: opts.registry });
  const httpServer =
    opts.httpServer ??
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('infcanvas game server (ws only)');
    });
  const wss = new WebSocketServer({ server: httpServer });

  const clients = new Set<ClientCtx>();
  let rejected = 0;

  function fullState(): FullState {
    return {
      time: sim.time,
      stockpile: { ...sim.stockpile },
      pawns: [...sim.pawns()].map((p) => structuredClone(p)),
      hostiles: sim.hostiles().map((h) => structuredClone(h)),
      buildings: [...sim.world.buildings.values()].map((b) => structuredClone(b)),
      events: structuredClone(sim.events),
      world: sim.world.exportState(),
    };
  }

  function send(ctx: ClientCtx, msg: ServerMsg): void {
    if (ctx.sock.readyState === WebSocket.OPEN) ctx.sock.send(JSON.stringify(msg));
  }

  wss.on('connection', (sock) => {
    const ctx: ClientCtx = { sock, lastPawnJson: new Map(), sentEvents: 0 };
    clients.add(ctx);
    // 新连接：先收 welcome（seed+tuning+全量），之后走常规节奏
    send(ctx, {
      t: 'welcome',
      d: { ...fullState(), seed: sim.world.seed, tuning: sim.tuning },
    });
    ctx.sentEvents = sim.events.length;
    for (const p of sim.pawns()) ctx.lastPawnJson.set(String(p.eid), JSON.stringify(p));

    sock.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        rejected++;
        return;
      }
      const m = parsed as { t?: string; c?: { type?: string; args?: Record<string, unknown> } };
      if (m?.t !== 'cmd' || typeof m.c?.type !== 'string') {
        rejected++;
        return;
      }
      const { type, args } = { type: m.c.type, args: m.c.args ?? {} };
      if (!SERVER_COMMANDS.includes(type)) {
        rejected++;
        return;
      }
      if (type === 'move' && !validMoveArgs(args)) {
        rejected++;
        return;
      }
      sim.issueCommand(type, args, 'player');
    });

    sock.on('close', () => clients.delete(ctx));
    sock.on('error', () => clients.delete(ctx));
  });

  // ---- tick 循环：固定步长推进权威模拟 ----
  const tickMs = opts.tickMs ?? 100;
  const timer = setInterval(() => sim.step(tickMs / 1000), tickMs);

  // ---- 增量同步 ~500ms：逐连接对照自己的基线（新事件/变更 pawn/删除名单）----
  const deltaMs = opts.deltaMs ?? 500;
  const deltaTimer = setInterval(() => {
    for (const ctx of clients) {
      const changedPawns: import('../sim/types').PawnState[] = [];
      const removedPawns: number[] = [];
      const currentIds = new Set<string>();
      for (const p of sim.pawns()) {
        const id = String(p.eid);
        currentIds.add(id);
        const json = JSON.stringify(p);
        if (ctx.lastPawnJson.get(id) === json) continue; // 该连接已知，跳过
        ctx.lastPawnJson.set(id, json);
        changedPawns.push(structuredClone(p));
      }
      for (const id of [...ctx.lastPawnJson.keys()]) {
        if (!currentIds.has(id)) {
          removedPawns.push(Number(id));
          ctx.lastPawnJson.delete(id);
        }
      }
      const newEvents = sim.events.slice(ctx.sentEvents);
      ctx.sentEvents = sim.events.length;
      send(ctx, {
        t: 'delta',
        d: {
          time: sim.time,
          stockpile: { ...sim.stockpile },
          pawns: changedPawns,
          removedPawns,
          hostiles: sim.hostiles().map((h) => structuredClone(h)),
          buildings: [...sim.world.buildings.values()].map((b) => structuredClone(b)),
          newEvents,
        },
      });
    }
  }, deltaMs);

  // ---- 全量对账 ~5s：重置每连接的增量基准（自愈任何漂移）----
  const fullMs = opts.fullMs ?? 5000;
  const fullTimer = setInterval(() => {
    for (const ctx of clients) {
      ctx.lastPawnJson.clear();
      ctx.sentEvents = sim.events.length;
      send(ctx, { t: 'full', d: fullState() });
    }
  }, fullMs);

  return new Promise((resolve) => {
    const done = (): void =>
      resolve({
        sim,
        get port(): number {
          const addr = httpServer.address();
          return typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
        },
        clientCount: () => clients.size,
        rejectedCommands: () => rejected,
        async close(): Promise<void> {
          clearInterval(timer);
          clearInterval(deltaTimer);
          clearInterval(fullTimer);
          for (const ctx of clients) ctx.sock.close();
          await new Promise<void>((r) => wss.close(() => r()));
          if (!opts.httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    if (opts.httpServer) {
      done(); // 复用外部 server：它已在监听
    } else {
      httpServer.listen(opts.port ?? 8080, () => done());
    }
  });
}
