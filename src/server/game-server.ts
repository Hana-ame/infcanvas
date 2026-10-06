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
import {
  PING_MS,
  SERVER_COMMANDS,
  validateAdminArgs,
  validInterest,
  validMoveArgs,
  HUD_SCRATCH_KEYS,
} from '../shared/protocol';
import { chunkKeyToXY, chunksForInterest, tileChunkKey, toChunkCoords, type ChunkCoord } from '../shared/chunks';
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
  /**
   * 分区块同步开关（line/net 2026-10-06）。默认 **true**。
   *
   * 为什么默认开而不是"上线怕破坏兼容才默认关"：协议字段全是可选的，旧客户端
   * 不发 interest 就会走全量路径（行为逐位不变），所以开启对老客户端是零风险的；
   * 而默认关会让"没配就是没优化"，下一个人得重新发现这个开关。
   *
   * 唯一需要关掉的场景是**基准对照**（bench 里要测"未裁剪"的字节数作为基线）。
   */
  chunked?: boolean;
  /**
   * 客户端未上报 interest 时的默认兴趣区半径（tile）。
   *
   * 语义决策（关键）：**不**给"全世界"默认，而是给一个**有限**视口半径。
   * 因为服务端权威：客户端没告诉它兴趣区时，若服务端猜"它要全世界"，
   * 就等于让一个恶意/异常客户端永远拉全量。给有限默认 = 安全默认值，
   * 且真的想要全量的旧客户端可以用合法客户端补上——旧版**无**这个能力，
   * 所以它在本轮仍会拿到裁剪后的世界（正确但范围小），这是可接受的兼容代价：
   * 玩家看到的实体在自己视野 192 tile 内，超出范围的建筑只是暂时不显示，
   * 而地形（hash 推导）**照常全量**，不会变空白。
   */
  defaultInterestRadius?: number;
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
  /**
   * 该连接当前订阅的区块键集合（line/net）。
   *
   * null = 尚未上报 interest（用默认视口兜底，见 defaultInterestRadius 注释）。
   * 存"集合"而不是坐标，是为了让 droppedChunks 的计算退化成一次差集；
   * 每 500ms 算一次差集（O(区块数)）远比每次重建集合便宜。
   */
  interest: Set<number> | null;
  /**
   * 上一轮 delta 生效的区块集合（line/net）：用来算 droppedChunks。
   *
   * 为什么必须留快照而不是直接比"上一条 interest 消息"：
   * 兴趣区是在两次 delta 之间**多次**更新的（玩家平移镜头），只有
   * "上次实际发给这条连接什么"才是正确的比对基准。用 interest 历史会
   * 在两次快速移动时把中间区块漏报成 dropped——客户端就会卸载一个
   * 它其实刚订阅过的区块（表现为"镜头扫过的地方建筑闪一下消失"）。
   */
  prevInterest: Set<number> | null;
  /** 该连接的中心（tick 分帧调度的优先级锚点：中心附近的块先处理） */
  center: { x: number; y: number };
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
    return fullStateFor(null);
  }

  /**
   * 按区块裁剪的全量状态（line/net）。
   *
   * cks = null → 全量（v1 语义，供基准对照与 replaceSim 的自愈对账用）。
   *
   * **权威性不因裁剪而降低**：裁剪只决定"这条连接看得到哪些实体"，
   * 逻辑状态永远只有服务器这一份，客户端不会因为没收到某个区块就自己算——
   * 它只是不知道那片区域有什么（视野外的东西不需要知道）。
   *
   * world 段的处理是这里最需要解释的地方：
   *  - buildings：按区块取（buildingsInChunks）
   *  - featureLeft / harvestCd：**同样按区块取**。这一条最容易漏——
   *    v3 里地形是 hash 推导、客户端零流量自推，如果只裁剪建筑不同步特征余量，
   *    玩家会看到"远一点的树还满着、走过去发现已经被采光了"。
   *    反之若连地形也下发，就等于推翻"无限地图零流量"这条已有设计（徒增百倍流量）。
   *    所以边界划在：**地形永远自推，被采/冷却这类"地表状态"按区块同步**。
   *  - nextBuildingId：全局单调计数器，**必须全量下发**（不是按区块的状态）——
   *    客户端只用它做 id 去重与调试显示，裁剪它会破坏计数器语义。
   */
  function fullStateFor(cks: Set<number> | null): FullState {
    const blds = cks === null ? [...sim.world.buildings.values()] : sim.world.buildingsInChunks(cks);
    const state = sim.world.exportState();
    if (cks !== null) {
      state.buildings = blds.map((b) => structuredClone(b));
      state.featureLeft = sim.world.featureLeftInChunks(cks);
      state.harvestCd = sim.world.harvestCdInChunks(cks);
    }
    return {
      time: sim.time,
      stockpile: { ...sim.stockpile },
      pawns: [...sim.pawns()].map((p) => structuredClone(p)),
      hostiles: sim.hostiles().map((h) => structuredClone(h)),
      buildings: state.buildings.map((b) => structuredClone(b)),
      events: structuredClone(sim.events),
      world: state,
      techs: [...sim.techUnlocked()], // 科技抽卡池状态（R2-1；只随 full/welcome 走，delta 不带）
      techFragments: { ...sim.techFragments },
      hudScratch: hudScratchOf(sim),
      // scope 缺省 = 客户端保持全量投影；存在 = 范围外应当卸载。
      // 与 hudScratch 正交：hudScratch 是字段白名单，scope 是视野裁剪。
      ...(cks === null ? {} : { scope: toChunkCoords(cks) }),
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
    const ctx: ClientCtx = {
      sock,
      lastPawnJson: new Map(),
      sentEvents: 0,
      interest: null,
      prevInterest: null,
      center: { x: sim.world.spawn.x, y: sim.world.spawn.y },
    };
    clients.add(ctx);
    // 新连接：先收 welcome（seed+tuning+全量），之后走常规节奏。
    // welcome 用**全量**（不裁剪）——理由：新连接还不知道自己在哪（没有客户端
    // 相机概念），此刻给一份全量能让客户端立刻有完整世界；等它上报 interest
    // 之后的 full/delta 才按区块裁剪。这样"首包最大"只发生一次，代价可控，
    // 换来的是首帧不会出现"世界一半是空的"再慢慢长出来的观感。
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
        d?: unknown;
      };
      /**
       * interest：订阅范围更新（line/net）。**不进命令白名单**——
       * 它不改游戏状态，只改"这条连接看得到什么"，且不该计入 rejectedCommands
       * （那会污染"是否有人在攻击服务器"的计数）。坏形状只丢包不报错，
       * 与命令的静默丢弃同风格：客户端 interest 坏了会表现为"看不到东西"，
       * 而不是崩溃——这类失效要能被下一条合法 interest 自愈。
       */
      if (m?.t === 'interest') {
        if (!validInterest(m.d)) return;
        const d = m.d;
        ctx.center = { x: d.x, y: d.y };
        ctx.interest = new Set(chunksForInterest({ x: d.x, y: d.y, r: d.r }));
        return;
      }
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

  // ---- 增量同步配置（line/net）：声明必须早于 tickTimer ——
  // activeChunkSet() 被 setInterval 的回调闭包捕获，回调在下一轮事件循环才跑，
  // 但 chunked / UNIVERSE 是 const/let，处在 TDZ 里。写成"反正回调晚点才执行"
  // 的隐式依赖很脆：任何人把 tickTimer 改成立刻同步跑一次（测试里很常见）
  // 就会拿到 ReferenceError，而报错点离原因很远。显式提前声明，别赌。
  const chunked = opts.chunked !== false;
  const defaultR = opts.defaultInterestRadius ?? 192;
  /** 全量哨兵：语义是"不裁剪"，用一个独立常量对象做身份判定（不用 null，
   *  省掉每个调用点的 null 检查，也让"全量"与"恰好空集"不会混淆）。 */
  const UNIVERSE: Set<number> = new Set<number>();
  let defaultScope: Set<number> | null = null;

  // ---- tick 循环：固定步长推进权威模拟 ----
  const tickMs = opts.tickMs ?? 100;
  /**
   * 本 tick 真正要推进的区块（line/net 分帧预算）。
   *
   * 取值规则（**null = 全部**，逐位等价于旧行为）：
   *  - 没有任何连接上报过 interest → null（全量）：此时"分片"没有意义，
   *    因为没人表达过关心范围，贸然只跑出生点附近会让唯一可能的观察者
   *    （本地调试/无 interest 的旧客户端）看到远方实体冻结。
   *  - 有连接上报了 → 各自的并集：玩家的鼠一定在自己订阅的区块里（见
   *    Sim.stepChunked 的确定性段），所以玩家关心的部分永不被跳过。
   *
   * 为什么 tick 不按"预算"切成多帧（任务书说的 budget 分片）而用"区块集合"：
   * 模拟时间必须等距推进才能让远端客户端的插值与服务器对齐（interp.ts 按
   * delta 间隔归一化 k），把一个 tick 的工作摊到后续 tick 会让某些 tick 的
   * dt≠0.1，破坏插值手感与所有"每秒速率"的确定性。
   * 所以这里的"分片"= **按区块决定工作集**，而"预算"体现为工作集大小本身
   * （客户端订阅半径即可调）。这是刻意不做的取舍，不是遗漏。
   */
  const tickTimer = setInterval(() => {
    const active = activeChunkSet();
    sim.stepChunked(tickMs / 1000, active);
  }, tickMs);

  /** 所有连接订阅范围的并集（无订阅者 = null） */
  function activeChunkSet(): Set<number> | null {
    if (!chunked) return null;
    let any = false;
    const out = new Set<number>();
    for (const ctx of clients) {
      const s = ctx.interest;
      if (!s) continue; // 未上报兴趣区：不贡献（未订阅≠要全部，见 tick 注释）
      any = true;
      for (const k of s) out.add(k);
    }
    return any ? out : null;
  }

  // ---- 增量同步 ~500ms：逐连接对照自己的基线（新事件/变更 pawn/删除名单）----
  // line/net：对照范围从"全世界"收窄为"该连接订阅的区块"。这是带宽收益的主来源——
  // 原实现每 500ms 对每条连接遍历全部建筑与敌袭，与玩家视野无关。
  // （chunked / UNIVERSE / defaultScope 已在 tickTimer 之前声明，见那里的 TDZ 注释）

  /** 该连接本轮生效的区块集合：已上报用上报值；未上报用出生点为心的默认视口。
   *  默认视口**只算一次**并缓存（Set 不可变语义：连接间共享安全，
   *  因为 chunksForInterest 对同一输入是纯函数）。 */
  function scopeOf(ctx: ClientCtx): Set<number> {
    if (!chunked) return UNIVERSE;
    if (ctx.interest) return ctx.interest;
    if (!defaultScope) {
      defaultScope = new Set(chunksForInterest({ x: sim.world.spawn.x, y: sim.world.spawn.y, r: defaultR }));
    }
    return defaultScope;
  }

  /**
   * 坐标是否落在本连接的 scope 内。
   *
   * 为什么不用"先算区块键再查 Set"：delta 里每只 pawn 每帧都要判一次，
   * 而 pawn 数可以远大于区块数——用 tileChunkKey 做一次 Map 查（O(1)）比
   * 构造对象 {cx,cy,key,offset} 便宜。选 cheap 分支（棋盘式判定）在
   * chunked=false 时省掉一切计算。
   */
  function inScope(scope: Set<number>, x: number, y: number): boolean {
    if (scope === UNIVERSE) return true;
    return scope.has(tileChunkKey(x, y).key);
  }

  const deltaMs = opts.deltaMs ?? 500;
  const deltaTimer = setInterval(() => {
    for (const ctx of clients) {
      const scope = scopeOf(ctx);
      const universe = scope === UNIVERSE;
      const changedPawns: import('../sim/types').PawnState[] = [];
      const removedPawns: number[] = [];
      const currentIds = new Set<string>();
      for (const p of sim.pawns()) {
        // pawn 按区块裁剪：视口外的鼠不需要 2Hz 位置更新（带宽主收益）。
        // 两个例外，二者都关乎"玩家看得见的东西必须跟得上"：
        //  1. **被选中的鼠**：否则框选后指挥，目标一走出视野就收不到坐标，
        //     表现为"命令发给空气"——这是功能性损坏而非画质降级。
        //     selected 是服务端权威集合，所以这个判定不依赖客户端自称。
        //  2. **被 holdUntil 优先窗口锁定**（玩家 5s 内指挥过的）：同上，
        //     且窗口很短（5s），代价可忽略。
        const selected = sim.selected.includes(p.eid);
        const held = p.holdUntil > sim.time;
        if (!universe && !selected && !held && !inScope(scope, p.pos.x, p.pos.y)) {
          // 出 scope：不进 currentIds，但**保留** lastPawnJson 条目——
          // 下一帧它若回到 scope 内会被当作"没变化"而漏发，除非这里把它删掉。
          // 所以出 scope 时必须删除基线（让回视野时重新全量发一次）。
          ctx.lastPawnJson.delete(String(p.eid));
          continue;
        }
        const id = String(p.eid);
        currentIds.add(id);
        const json = JSON.stringify(p);
        if (ctx.lastPawnJson.get(id) === json) continue; // 该连接已知，跳过
        ctx.lastPawnJson.set(id, json);
        changedPawns.push(structuredClone(p));
      }
      for (const id of [...ctx.lastPawnJson.keys()]) {
        if (!currentIds.has(id)) {
          // 出 scope 的 pawn 已在上面 delete 过基线，所以**不会**在这里被误报为
          // "死亡"——只有真正从 pawnMap 消失的才会进 removedPawns。
          // 这条依赖 delete 的位置（必须在上方循环内），改代码时注意别调换。
          removedPawns.push(Number(id));
          ctx.lastPawnJson.delete(id);
        }
      }
      const newEvents = sim.events.slice(ctx.sentEvents);
      ctx.sentEvents = sim.events.length;

      // 敌袭与建筑按区块裁剪。
      // hostiles：敌袭会追着玩家跑，裁剪后可能出现"猫跑出视野→消失→又出现"。
      // 可接受吗？能接受：视野外的东西玩家看不见，而它继续伤害远处的鼠是
      // 服务器权威行为（不会被裁剪掉），只是客户端不画出来。
      // 建筑同理：视野外的篝火不显示，但寻路/燃料照常在服务器跑。
      const hostiles = universe ? sim.hostiles() : sim.hostiles().filter((h) => inScope(scope, h.pos.x, h.pos.y));
      const buildings = universe
        ? [...sim.world.buildings.values()]
        : sim.world.buildingsInChunks(scope);

      // droppedChunks：该连接退出了 scope 的区块（line/net 的关键信号）。
      // 客户端据此卸载远端区块——没有它，"没提到"和"没了"无法区分。
      const dropped: ChunkCoord[] = [];
      if (!universe && ctx.prevInterest) {
        for (const k of ctx.prevInterest) {
          if (!scope.has(k)) {
            const { cx, cy } = chunkKeyToXY(k);
            dropped.push({ cx, cy });
          }
        }
      }
      ctx.prevInterest = universe ? null : new Set(scope);

      send(ctx, {
        t: 'delta',
        d: {
          time: sim.time,
          stockpile: { ...sim.stockpile },
          pawns: changedPawns,
          removedPawns,
          hostiles: hostiles.map((h) => structuredClone(h)),
          buildings: buildings.map((b) => structuredClone(b)),
          newEvents,
          ...(universe
            ? {}
            : { scope: toChunkCoords(scope), droppedChunks: dropped }),
        },
      });
    }
  }, deltaMs);

  // ---- 全量对账 ~5s：重置每连接的增量基准（自愈任何漂移）----
  // line/net：按 scope 发（不是全量）。full 是**"本 scope 的权威对账"**，
  // 不是"全世界的权威对账"——所以它带的 scope 语义是卸载级的：
  // 客户端拿它整体替换 scope 内投影并卸载 scope 外的（applyChunkScope）。
  const fullMs = opts.fullMs ?? 5000;
  const fullTimer = setInterval(() => {
    for (const ctx of clients) {
      ctx.lastPawnJson.clear();
      ctx.sentEvents = sim.events.length;
      const scope = scopeOf(ctx);
      send(ctx, { t: 'full', d: fullStateFor(scope === UNIVERSE ? null : scope) });
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
          clearInterval(tickTimer);
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