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
import { PING_MS, SERVER_COMMANDS, validateAdminArgs, validMoveArgs, HUD_SCRATCH_KEYS } from '../shared/protocol';
import { authorizeAdmin, authorizeHandshake } from './auth';
import { SaveStore, timestampName } from './save-store';
import { loadSim, snapshotOf, type SaveData } from '../sim/sim-save';

export interface GameServerOptions {
  port?: number;
  seed?: number;
  registry: ModRegistry;
  /** 现成 http.Server（测试/反代场景）；不给就自建 */
  httpServer?: HttpServer;
  tickMs?: number;
  deltaMs?: number;
  fullMs?: number;
  /** 心跳广播周期（ms），默认 PING_MS=10s；测试可调小 */
  pingMs?: number;
  /** R1-2 握手 token：给了就要求 ?token= 精确匹配；不给=完全开放（本地默认） */
  serverToken?: string | undefined;
  /** R1-5 管理命令（save/load）token；不给则回退到 serverToken */
  adminToken?: string | undefined;
  /** R1-5 存档目录；不给则用 cwd 下的 saves/ */
  saveDir?: string;
  /** R1-5 启动即读档（CLI --load 传进来） */
  loadFrom?: string | undefined;
}

export interface GameServerHandle {
  sim: Sim;
  port: number;
  clientCount(): number;
  rejectedCommands(): number;
  /** R1-5 最近一次存档结果（CLI 打印用；null = 还没存过） */
  lastSave(): { name: string; path: string } | null;
  close(): Promise<void>;
}

interface ClientCtx {
  sock: WebSocket;
  lastPawnJson: Map<string, string>;
  sentEvents: number;
}

export function createGameServer(opts: GameServerOptions): Promise<GameServerHandle> {
  const store = new SaveStore(opts.saveDir ?? 'saves');
  // R1-5 启动即读档：必须在建 Sim 之前完成——Sim 构造函数会建世界、装配系统，
  // 读档路径要走 restore 分支（跳过 init），所以只能二选一，不能事后再灌。
  let sim: Sim;
  if (opts.loadFrom) {
    sim = loadSim(store.read(opts.loadFrom), opts.registry);
  } else {
    sim = new Sim({ seed: opts.seed ?? 42, registry: opts.registry });
  }
  const httpServer =
    opts.httpServer ??
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('infcanvas game server (ws only)');
    });
  const wss = new WebSocketServer({ server: httpServer });

  const clients = new Set<ClientCtx>();
  let rejected = 0;
  /** R1-5 最近一次存档元信息（CLI 打印用） */
  let lastSaved: { name: string; path: string } | null = null;

  /**
   * R1-5 读档后整包替换权威 Sim。
   * 为什么必须重建实例而不是改字段：Sim 的 rng 状态、nextEid、scratch、
   * 系统内部闭包态都是实例私有，逐字段搬运一定会漏，漏一项就让「确定性续跑」
   * 对拍失败，而且这种 bug 表现为「读档后行为慢慢分叉」，极难定位。
   * 顺带把全量同步定时器打开：换实例后所有连接的增量基准已失效，必须让它们
   * 尽快收到一份 full 对账，否则客户端会继续拿着旧实体的增量数据。
   */
  function replaceSim(next: Sim): void {
    sim = next;
    for (const ctx of clients) {
      ctx.lastPawnJson.clear();
      ctx.sentEvents = sim.events.length;
      // 走共享的 fullState()，不要内联第二份副本（2026-10-06 R1+R2 合并修）：
      // 内联那份漏了 R2-1 新增的 techs/techFragments 字段，replaceSim 触发的重连
      // 对账会静默少发科技状态——客户端科技面板在重连后倒退。
      send(ctx, { t: 'full', d: fullState() });
    }
  }

  function fullState(): FullState {
    return {
      time: sim.time,
      stockpile: { ...sim.stockpile },
      pawns: [...sim.pawns()].map((p) => structuredClone(p)),
      hostiles: sim.hostiles().map((h) => structuredClone(h)),
      buildings: [...sim.world.buildings.values()].map((b) => structuredClone(b)),
      events: structuredClone(sim.events),
      world: sim.world.exportState(),
      techs: [...sim.techUnlocked()], // 科技抽卡池状态（R2-1；只随 full/welcome 走，delta 不带）
      techFragments: { ...sim.techFragments },
      hudScratch: hudScratchOf(sim),
    };
  }

  /**
   * HUD 面板需要的 scratch 子集（R3-HUD）：按白名单挑选，不外推整个 scratch。
   * 键不存在 = 该包没挂（值为 undefined → 不落键，客户端回落到"未知"而非假 0）。
   */
  function hudScratchOf(sim: Sim): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of HUD_SCRATCH_KEYS) {
      const v = sim.scratch[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  function send(ctx: ClientCtx, msg: ServerMsg): void {
    if (ctx.sock.readyState === WebSocket.OPEN) ctx.sock.send(JSON.stringify(msg));
  }

  /**
   * R1-2 握手鉴权。ws 的 'connection' 事件**晚于** upgrade 完成——
   * 此时拿到的已经是握手后的 socket，所以只能立刻 close(1008) 表示拒绝，
   * 不能回 401（HTTP 响应在 upgrade 阶段就该给，那属于 'upgrade' 事件的事）。
   * 未配置 token 时直接放行，保证本地开发行为零变化。
   */
  wss.on('connection', (sock, req) => {
    const verdict = authorizeHandshake(opts.serverToken, req.url ?? '/');
    if (!verdict.ok) {
      sock.close(1008, verdict.reason ?? 'unauthorized');
      return; // 不入 clients 集合：这个连接从一开始就不存在
    }
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
      const m = parsed as {
        t?: string;
        c?: { type?: string; args?: Record<string, unknown>; src?: string; token?: string };
      };
      if (m?.t !== 'cmd' || typeof m.c?.type !== 'string') {
        rejected++;
        return;
      }
      const { type, args } = { type: m.c.type, args: m.c.args ?? {} };
      // 第一道闸：白名单。不在 SERVER_COMMANDS 里就静默丢弃——**不报错**是刻意的
      // （服务端不向客户端回显错误，避免把内部命令面暴露出去）。
      // R1-5 踩坑：save/load 没登记白名单时命令发出去毫无反应，排查成本极高。
      if (!SERVER_COMMANDS.includes(type)) {
        rejected++;
        return;
      }
      // 第二道闸：参数校验。命令存在 ≠ 参数合法。
      if (type === 'move' && !validMoveArgs(args)) {
        rejected++;
        return;
      }
      if ((type === 'save' || type === 'load') && !validateAdminArgs(type, args)) {
        rejected++;
        return;
      }
      // R1-5 管理命令不走 issueCommand：save/load 是服务器运维动作，不是玩法指令，
      // 走系统内部处理（load 要整包替换 sim，与 issueCommand 的语义完全不搭）。
      if (type === 'save' || type === 'load') {
        const auth = authorizeAdmin({ src: m.c.src, token: m.c.token }, opts.adminToken ?? opts.serverToken);
        if (!auth.ok) {
          rejected++;
          return;
        }
        try {
          if (type === 'save') {
            const name = typeof args.name === 'string' && args.name ? args.name : timestampName(Date.now());
            store.write(name, snapshotOf(sim));
            lastSaved = { name, path: store.pathFor(name) };
          } else {
            const file = args.file as string;
            const raw = store.read(file) as SaveData;
            const restored = loadSim(raw, opts.registry);
            // 读档必须整包换掉权威 Sim：spawned 系统状态、rng、scratch 都在实例里，
            // 逐字段搬运必然漏。重建实例是唯一能保证「确定性续跑」的做法。
            replaceSim(restored);
          }
        } catch (err) {
          // 坏档/写失败：响亮记日志但不崩服务器（一个玩家的坏命令不该带走整局）
          console.error('[game-server] save/load 失败：', err);
          rejected++;
        }
        return;
      }
      sim.issueCommand(type, args, 'player');
    });

    sock.on('close', () => clients.delete(ctx));
    sock.on('error', () => clients.delete(ctx));
  });

  // ---- 心跳（R1-1）：无条件广播，让客户端能判定链路活性 ----
  // 无条件而非「有变化才发」：看门狗要的是「链路还活着」的证据，
  // 靠内容变化推断活性会在静止世界里误判假死。
  const pingMs = opts.pingMs ?? PING_MS;
  const pingTimer = setInterval(() => {
    const msg: ServerMsg = { t: 'ping', d: { time: sim.time } };
    for (const ctx of clients) send(ctx, msg);
  }, pingMs);

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
        lastSave: () => lastSaved,
        async close(): Promise<void> {
          clearInterval(timer);
          clearInterval(deltaTimer);
          clearInterval(fullTimer);
          clearInterval(pingTimer);
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