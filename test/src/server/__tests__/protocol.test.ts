import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { RemoteSim } from '../../client/remote';
import type { WelcomeMsg, SnapshotMsg, EventMsg, DeltaMsg } from '../../shared/protocol';
import { validateCommand, type CmdGuardState } from '../cmdValidate';
import { buildDelta } from '../diff';
import { World, MAX_TILE } from '../../sim/core/world';

// P1 server 骨架（DESIGN §5/§8）：权威在 server，客户端只读视图
describe('server 网络层基础（P1）', () => {
  it('tile 变更经 onTileChange 上报（server 推增量的来源）', () => {
    const sim = new Sim({ seed: 7, pawnCount: 1 });
    const seen: [number, number, string][] = [];
    sim.addTileListener((x, y, id) => seen.push([x, y, id]));
    // 动态找两个非目标 tile（世界生成参数化后坐标不稳定）
    let a: [number, number] = [2, 2];
    let b: [number, number] = [3, 3];
    for (let y = 2; y < 40 && (sim.world.getTile(a[0], a[1]) === 'grass' || sim.world.getTile(b[0], b[1]) === 'grass'); y++) {
      for (let x = 2; x < 40; x++) {
        if (sim.world.getTile(x, y) !== 'grass') { if (sim.world.getTile(a[0], a[1]) === 'grass') a = [x, y]; else b = [x, y]; }
      }
    }
    sim.world.setTile(a[0], a[1], 'grass');
    sim.world.setTile(b[0], b[1], 'dirt');
    sim.world.setTile(a[0], a[1], 'grass'); // 重复 set 不触发
    expect(seen).toEqual([[a[0], a[1], 'grass'], [b[0], b[1], 'dirt']]);
  });

  it('addTileListener 退订后不再上报', () => {
    const sim = new Sim({ seed: 7, pawnCount: 1 });
    let n = 0;
    const off = sim.addTileListener(() => n++);
    sim.world.setTile(3, 3, 'dirt');
    off();
    sim.world.setTile(4, 4, 'dirt');
    expect(n).toBe(1);
  });

  it('RemoteSim: welcome 初始化世界底（defs 只读表 + tileGrid）', () => {
    const rs = new RemoteSim('ws://unused');
    // 手工喂 welcome（等价于 server 下发）
    const welcome: WelcomeMsg = {
      type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120, tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
      world: { width: 4, height: 3 },
      tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
      buildings: { campfire: { id: 'campfire', name: '篝火', size: { x: 1, y: 1 }, color: '#f4a340', passable: true, hp: 100 } },
      items: { wood: { id: 'wood', name: '木头' } },
      tileGrid: [{ x: 0, y: 0, tiles: (() => { const t = new Array(4096).fill('grass'); t[(1 % 64) * 64 + (5 % 64)] = 'water'; return t; })() }],
    };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(welcome));
    expect(rs.world.width).toBe(4);
    expect(rs.world.height).toBe(3);
    expect(rs.world.getTile(0, 0)).toBe('grass');
    expect(rs.world.getTile(5, 1)).toBe('water');
    expect(rs.mods.buildings.campfire.name).toBe('篝火');
    expect(rs.mods.items.wood.name).toBe('木头');
  });

  it('RemoteSim: 快照驱动 pawns/资源/建筑 + tile 增量事件更新地面', () => {
    const rs = new RemoteSim('ws://unused');
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify({
      type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120, tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
      world: { width: 4, height: 3 },
      tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
      buildings: {},
      items: {},
      tileGrid: [{ x: 0, y: 0, tiles: new Array(4096).fill('grass') }],
    } satisfies WelcomeMsg));

    const snap: SnapshotMsg = {
      type: 'snapshot', t: 42, paused: false, speed: 1, isNight: true, day: 2,
      weather: { raining: true, temperature: 13 },
      stockpile: { wood: 10, food: 5 },
      pawns: [{
        eid: 9, x: 1, y: 1, hp: 80, maxHp: 100, job: 'lumberjack',
        needs: { food: 50, rest: 60, mood: 70, san: 80 }, faith: 30,
        attrs: { str: 10, con: 10, siz: 10, dex: 10, int: 10, pow: 10, app: 10, edu: 10 },
        skills: { work: 3 }, traits: ['强壮'], maxSlots: 2,
        slots: [{ id: 'eat', name: '进食' }], desires: { hunger: 42 },
        lastDecision: { drawn: ['eat', 'rest'], picked: 'eat', time: 40 },
        worn: 'red_peltShirt', // 穿着衣物（clothing 玩法包 2026-08-15：客户端染色 tint 用）
      }],
      hostiles: [], buildings: [], buildQueue: [], buildingVersion: 1,
    };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(snap));

    expect(rs.time).toBe(42);
    expect(rs.isNight()).toBe(true);
    expect(rs.env).toEqual({ raining: true, temperature: 13, rainLeft: 0 });
    expect(rs.stockpile.wood).toBe(10);
    expect(rs.pawns).toEqual([9]);
    const prof = rs.pawnProfile(9);
    expect(prof?.job).toBe('lumberjack');
    expect(prof?.dna.traits).toEqual(['强壮']);
    expect(prof?.slots[0]?.name).toBe('进食');
    expect(prof?.lastDecision?.picked).toBe('eat');
    expect(rs.healthOf(9)).toEqual({ hp: 80, maxHp: 100 });
    expect(rs.wornOf(9)).toBe('red_peltShirt'); // worn 透传（快照字段 → 客户端渲染查询）

    // 采集换地形：server 推 tileChanged → 客户端地面更新
    const ev: EventMsg = { type: 'event', t: 42.5, events: [{ kind: 'tileChanged', x: 2, y: 0, tileId: 'dirt' }] };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(ev));
    expect(rs.world.getTile(2, 0)).toBe('dirt');

    // 快照更新建筑（server 权威回显）
    snap.buildings = [{ key: 0 + 0 * 2 ** 31, defId: 'campfire', x: 0, y: 0, hp: 100, maxHp: 100, faction: 'A', footprint: [{ x: 0, y: 0 }] }];
    snap.buildingVersion = 2;
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(snap));
    expect(rs.world.buildingVersion).toBe(2);
    expect(rs.buildingAt(0, 0)?.defId).toBe('campfire');
  });

  it('delta worn 合并：穿衣/脱衣即时更新 tint 查询（2026-08-15 审计回归）', () => {
    // 发现背景（2026-08-15 审计）：server diff 已对 worn 变化发 delta（diff.ts:46），
    // 但客户端 applyDelta 合并表漏 worn → 远程穿衣后 wornOf 不更新、染色 tint 等 5s
    // 全量对账才刷新。修复 = 合并表补 `pd.worn !== undefined`（'' = 脱衣也要覆盖）。
    const rs = new RemoteSim('ws://unused');
    rs.tickHz = 20; rs.dayLength = 120;
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify({
      type: 'welcome', you: 1, seed: 1, tickHz: 20, dayLength: 120,
      tuning: { needs: { foodMoodLow: 30 }, faction: {}, env: { dayLength: 120, baseTemp: 20 } },
      world: { width: 4, height: 3 },
      tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
      buildings: {}, items: {},
      tileGrid: [{ x: 0, y: 0, tiles: new Array(4096).fill('grass') }],
    } satisfies WelcomeMsg));

    const snap: SnapshotMsg = {
      type: 'snapshot', t: 42, paused: false, speed: 1, isNight: false, day: 2,
      weather: { raining: false, temperature: 18 },
      stockpile: {},
      pawns: [{ eid: 9, x: 1, y: 1, hp: 80, maxHp: 100, job: 'lumberjack', needs: { food: 0, rest: 0, mood: 0, san: 0 }, faith: 30, attrs: { str: 10, con: 10, siz: 10, dex: 10, int: 10, pow: 10, app: 10, edu: 10 }, skills: {}, traits: [], maxSlots: 2, slots: [], desires: {}, worn: undefined }],
      hostiles: [], buildings: [], buildQueue: [], buildingVersion: 1,
    };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(snap));
    expect(rs.wornOf(9)).toBeUndefined();

    // 穿衣 delta：worn 字段增量 → 即时生效（不等对账）
    const delta: DeltaMsg = { type: 'delta', t: 42.25, pawns: [{ eid: 9, worn: 'peltShirt' }] };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(delta));
    expect(rs.wornOf(9)).toBe('peltShirt');

    // 脱衣 delta：worn=''（server 用空串表示脱下）→ 必须覆盖回 undefined
    const delta2: DeltaMsg = { type: 'delta', t: 42.5, pawns: [{ eid: 9, worn: '' }] };
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(delta2));
    expect(rs.wornOf(9)).toBeUndefined();
  });
});

// ---- H1（2026-08-20 审计修复）：播放控制 = 引擎内建命令面 ----
// 此前 main.ts/hud.ts 直改 sim.paused/speed：远程模式改的是本地壳字段，服务器权威
// 不知情 → HUD 谎报暂停、时钟漂移。修复后唯一写入路径 = issueCommand（pause/speed
// 与 move 同层硬编码分支），cmdValidate 白名单 + 形状校验，RemoteSim 经既有命令通道。
describe('引擎内建播放控制命令面（H1，2026-08-20）', () => {
  it('本地 Sim：pause/speed 命令生效（值域内），非法值静默忽略', () => {
    const sim = new Sim({ seed: 9, pawnCount: 1 });
    sim.issueCommand({ type: 'pause', x: 0, y: 0 });
    expect(sim.paused).toBe(true); // args 缺省 = 暂停
    sim.issueCommand({ type: 'pause', x: 0, y: 0, args: { paused: false } });
    expect(sim.paused).toBe(false);
    sim.issueCommand({ type: 'speed', x: 0, y: 0, args: { speed: 2 } });
    expect(sim.paused).toBe(false);
    expect(sim.speed).toBe(2);
    const before = { paused: sim.paused, speed: sim.speed };
    sim.issueCommand({ type: 'speed', x: 0, y: 0, args: { speed: 9 } }); // 值域外
    sim.issueCommand({ type: 'pause', x: 0, y: 0, args: { paused: 'yes' } } as never); // 形状外（本地宽容）
    expect(sim.paused).toBe(before.paused);
    expect(sim.speed).toBe(before.speed);
  });

  it('RemoteSim：pause/speed 命令经 {type:cmd} 通道上行，不直改本地字段', () => {
    const rs = new RemoteSim('ws://127.0.0.1:1');
    const sent: string[] = [];
    (rs as unknown as { ws: { readyState: number } & Record<string, unknown> }).ws = {
      readyState: 1,
      send: (s: string) => sent.push(s),
    };
    rs.issueCommand({ type: 'pause', x: 0, y: 0, args: { paused: true } });
    rs.issueCommand({ type: 'speed', x: 0, y: 0, args: { speed: 3 } });
    expect(sent).toHaveLength(2);
    const c1 = JSON.parse(sent[0]!).cmd;
    const c2 = JSON.parse(sent[1]!).cmd;
    expect(c1.type).toBe('pause');
    expect(c1.args.paused).toBe(true);
    expect(c2.type).toBe('speed');
    expect(c2.args.speed).toBe(3);
    // 本地字段不被动（权威 = server 回显的 snapshot/delta 才更新）
    expect(rs.paused).toBe(false);
    expect(rs.speed).toBe(1);
  });

  it('cmdValidate：pause/speed 白名单放行 + 形状校验（错误值拒收）', () => {
    const sim = new Sim({ seed: 10, pawnCount: 1 });
    const guard: CmdGuardState = { lastCmdAt: 0, budget: 30 };
    const v = (cmd: unknown) => validateCommand(sim, cmd, guard, Date.now()).ok;
    expect(v({ type: 'pause', x: 0, y: 0 })).toBe(true);
    expect(v({ type: 'pause', x: 0, y: 0, args: { paused: false } })).toBe(true);
    expect(v({ type: 'speed', x: 0, y: 0, args: { speed: 1 } })).toBe(true);
    expect(v({ type: 'speed', x: 0, y: 0, args: { speed: 0 } })).toBe(false);  // 值域外
    expect(v({ type: 'speed', x: 0, y: 0, args: { speed: 9 } })).toBe(false);  // 值域外
    expect(v({ type: 'pause', x: 0, y: 0, args: { paused: 'yes' } })).toBe(false); // 非布尔
  });
});

// ---- 审计 M2（2026-08-20）：applyDelta 不把增量形状灌进权威快照 ----
// 此前 this.snap = { ...this.snap, ...delta }：delta.pawns 是"逐 pawn 部分字段"增量，
// spread 后 snap.pawns 被整体替换 → 其余 pawn 蒸发、条目字段残缺（半残快照潜伏误读）。
// 修复后 = 逐 eid 字段合并（与 pawnCache 同源）+ 顶层字段单点赋值 + 对账仍为收敛点。
describe('applyDelta 权威快照合并（审计 M2，2026-08-20）', () => {
  function buildWelcome(_sim: Sim): WelcomeMsg {
    return {
      type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120,
      tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
      world: { width: 4, height: 3 },
      tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
      buildings: {}, items: {},
      tileGrid: [{ x: 0, y: 0, tiles: Array(12).fill('grass') }],
    };
  }
  function buildSnapshot(sim: Sim): SnapshotMsg {
    const all = sim.pawns.map((eid) => {
      const p = sim.pawnStates.get(eid)!;
      const pos = sim.pawnPositions.get(eid)!;
      return {
        eid, x: pos.x, y: pos.y, hp: sim.healthOf(eid)?.hp ?? 0, maxHp: sim.healthOf(eid)?.maxHp ?? 1, job: p.job ?? '', faith: p.faith ?? 0,
        attrs: { str: p.dna.str, con: p.dna.con, siz: p.dna.siz, dex: p.dna.dex, int: p.dna.int, pow: p.dna.pow, app: p.dna.app, edu: p.dna.edu },
        skills: { ...p.skills }, traits: [...(p.dna.traits ?? [])],
        maxSlots: 2, slots: [], desires: {},
      };
    });
    return {
      type: 'snapshot', t: sim.time, paused: sim.paused, speed: sim.speed, isNight: sim.isNight(),
      day: 1, weather: { raining: false, temperature: 18 },
      stockpile: { ...sim.stockpile }, pawns: all, hostiles: [],
      buildings: [...sim.world.buildings].map(([key, b]) => {
        const { x, y } = World.keyToXY(key);
        return { key, defId: b.def.id, x, y, hp: Math.round(b.hp), maxHp: b.def.hp, faction: b.faction, footprint: sim.world.footprintOf(x, y) };
      }),
      buildQueue: [], buildingVersion: sim.world.buildingVersion,
    };
  }
  function freshSim(pawnCount: number): { sim: Sim; rs: RemoteSim } {
    const sim = new Sim({ seed: 11, pawnCount });
    for (let i = 0; i < 10; i++) sim.step(0.02);
    // 走 server 快照序列：snapshot → 若干 delta（含半残形状的真实 diff）
    const rs = new RemoteSim('ws://127.0.0.1:1');
    const w = buildWelcome(sim);
    const feed = (raw: string) => (rs as unknown as { onMessage(s: string): void }).onMessage(raw);
    feed(JSON.stringify(w));
    feed(JSON.stringify(buildSnapshot(sim)));
    return { sim, rs };
  }
  const feedD = (rs: RemoteSim, d: DeltaMsg) =>
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(d));

  it('delta 增量合入后：snap.pawns 保留全部 pawn（不蒸发、形状全量）', () => {
    const { rs } = freshSim(3);
    const eids = () => (rs as unknown as { snap: SnapshotMsg }).snap.pawns.map((p) => p.eid);
    expect(eids()).toHaveLength(3);
    // 半残形状增量（diff 同构：只有 2 号 pawn 动了一点，条目只有变化字段）
    feedD(rs, { type: 'delta', t: 1, pawns: [{ eid: 2, x: 9, y: 9, hp: 3 }] });
    const snap = (rs as unknown as { snap: SnapshotMsg }).snap; // 每次 feedD 后重新取引用（applyDelta 浅克隆）
    expect(eids()).toEqual([1, 2, 3]);            // 不蒸发：其余 pawn 还在
    const pawn2 = snap.pawns.find((p) => p.eid === 2)!;
    expect(pawn2.hp).toBe(3);                     // 增量字段合入
    expect(typeof pawn2.maxHp).toBe('number');    // 未变化字段保留（不全量形状 = 半残误读）
    expect(typeof pawn2.job).toBe('string');
  });

  it('removed 摘除 + pawnList 权威重排（与 pawnCache 一致）', () => {
    const { rs } = freshSim(2);
    const eids = () => (rs as unknown as { snap: SnapshotMsg }).snap.pawns.map((p) => p.eid);
    feedD(rs, { type: 'delta', t: 1, pawns: [{ eid: 5, removed: true }] }); // eid 5 不存在也不炸
    expect(eids()).toEqual([1, 2]);
    feedD(rs, { type: 'delta', t: 1, pawnList: [2, 1] }); // 权威顺序重排
    expect(eids()).toEqual([2, 1]);
    feedD(rs, { type: 'delta', t: 1, pawns: [{ eid: 2, removed: true }] });
    expect(eids()).toEqual([1]);
    expect((rs as unknown as { pawns: number[] }).pawns).toEqual([1]);
  });

  it('顶层字段单点合入：weather/stockpile/buildings/buildQueue 不丢权威形状', () => {
    const { rs } = freshSim(1);
    feedD(rs, {
      type: 'delta', t: 2, weather: { raining: true, temperature: 10 },
      buildingVersion: 7, buildQueue: [{ x: 1, y: 1, defId: 'farm', progress: 0.5 }],
    } as never);
    const snap = (rs as unknown as { snap: SnapshotMsg }).snap;
    expect(snap.weather).toEqual({ raining: true, temperature: 10 });
    expect(snap.buildingVersion).toBe(7);
    expect(snap.buildQueue).toEqual([{ x: 1, y: 1, defId: 'farm', progress: 0.5 }]);
    expect(typeof snap.isNight).toBe('boolean'); // 未变化的字段保留（不 undefined）
  });
});

// ---- 审计 L2/L3（2026-08-20）----
// L2：RemoteWorld.canBuildAt 边界此前用 welcome 的 width/height 且拒绝负坐标——与 server
//     （无限地图 ±MAX_TILE）不一致 → 客户端 UI 说不可建、server 实际接受。修复对齐 MAX_TILE。
// L3：无 pawnList 的新 pawn 增量，this.pawns 此前按 pawnCache Map 插入序重建——与权威序
//     （snap.pawns 顺序）漂移。修复 = 跟随 snap 权威序。
describe('远程视图边界/权威序（审计 L2/L3，2026-08-20）', () => {
  function fresh(): { rs: RemoteSim; feedS: (s: SnapshotMsg) => void } {
    const rs = new RemoteSim('ws://127.0.0.1:1');
    const feed = (raw: string) => (rs as unknown as { onMessage(s: string): void }).onMessage(raw);
    const w: WelcomeMsg = {
      type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120,
      tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
      world: { width: 4, height: 3 },
      tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
      buildings: {}, items: {},
      tileGrid: [{ x: 0, y: 0, tiles: Array(12).fill('grass') }],
    };
    feed(JSON.stringify(w));
    const snap: SnapshotMsg = {
      type: 'snapshot', t: 0, paused: false, speed: 1, isNight: false, day: 1,
      weather: { raining: false, temperature: 18 }, stockpile: {},
      pawns: [
        { eid: 1, x: 2, y: 1, hp: 50, maxHp: 50, job: '', faith: 0, attrs: { str: 10, con: 10, siz: 10, dex: 10, int: 10, pow: 10, app: 10, edu: 10 }, skills: {}, traits: [], maxSlots: 2, slots: [], desires: {} },
        { eid: 2, x: 2, y: 2, hp: 50, maxHp: 50, job: '', faith: 0, attrs: { str: 10, con: 10, siz: 10, dex: 10, int: 10, pow: 10, app: 10, edu: 10 }, skills: {}, traits: [], maxSlots: 2, slots: [], desires: {} },
      ],
      hostiles: [], buildings: [], buildQueue: [], buildingVersion: 1,
    };
    feed(JSON.stringify(snap));
    return { rs, feedS: (s2: SnapshotMsg) => feed(JSON.stringify(s2)) };
  }
  const feedDelta = (rs: RemoteSim, d: DeltaMsg) =>
    (rs as unknown as { onMessage(s: string): void }).onMessage(JSON.stringify(d));

  it('L2：RemoteWorld 边界对齐无限地图 MAX_TILE（负坐标/区块外可建，超限拒绝）', () => {
    const { rs } = fresh();
    // welcome width=4 height=3：旧代码 x<0||x>=4 全拒；现在负坐标/区块外都在 MAX_TILE 内
    expect(rs.world.canBuildAt(-1, 0)).toBe(true);
    expect(rs.world.canBuildAt(5, 0)).toBe(true);
    expect(rs.world.canBuildAt(100, 200)).toBe(true);
    // 超 MAX_TILE 防御边界 → 拒绝（与 server/sim.world.inBounds 同语义）
    expect(rs.world.canBuildAt(MAX_TILE + 1, 0)).toBe(false);
    expect(rs.world.canBuildAt(0, -MAX_TILE - 1)).toBe(false);
  });

  it('L3：新 pawn 增量（无 pawnList）→ this.pawns 跟随 snap 权威序', () => {
    const { rs, feedS } = fresh();
    // 全量对账后权威序 = [1,2]；增量新增 eid 7（无 pawnList）→ snap 追加末尾、pawns 同步
    feedDelta(rs, { type: 'delta', t: 0.5, pawns: [{ eid: 7, x: 1, y: 1, hp: 40, maxHp: 50 }] });
    expect((rs as unknown as { pawns: number[] }).pawns).toEqual([1, 2, 7]);
    // 对账覆盖：authority 序变化（eid 7 排最前）→ 全量合并后 pawns = [7,1,2]
    const snap2 = (rs as unknown as { snap: SnapshotMsg }).snap;
    const reordered = { ...snap2, pawns: [snap2.pawns[2]!, snap2.pawns[0]!, snap2.pawns[1]!] } as SnapshotMsg;
    feedS(reordered);
    expect((rs as unknown as { pawns: number[] }).pawns).toEqual([7, 1, 2]);
    // 再增量（无 pawnList）仍跟随最新权威序，不清到插入序
    feedDelta(rs, { type: 'delta', t: 1, pawns: [{ eid: 1, x: 9, y: 9 }] });
    expect((rs as unknown as { pawns: number[] }).pawns).toEqual([7, 1, 2]);
  });
});
