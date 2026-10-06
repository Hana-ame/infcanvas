/**
 * fortify.test.ts —— line/fort 验收：防御建筑包（围墙/哨塔/陷阱）。
 *
 * 覆盖（对照任务清单）：
 *  ① 建筑表种子：三建筑的 造价/hp/tags/passable/w×h 与设计一致；哨塔同时挂
 *    K_TAG_TOWER + K_TAG_WAYPOINT + K_TAG_SHELTER 且**不**挂 K_TAG_FIRE。
 *  ② 卡片：build_wall 3 / build_tower 4 / build_trap 2，全是 SER_BUILD；
 *    意愿闸（造价 / 有威胁才修第二堵 / 塔数人口上限）四个方向都验。
 *  ③ tuning.fortify 四个出厂值。
 *  ④ 建造：debugForceCard + step 走真实 commit 路径；内核拒放时不扣料。
 *  ⑤ 阻挡：墙占格不可站、通往它的寻路失败（同格无墙时可站可达，对照内嵌）。
 *  ⑥ 墙间距：内核 minSpacing 拒近邻；包内 wallMinGap 预筛真的被消费。
 *  ⑦ 哨塔航点：进 waypoint/tower 桶、不进火桶；长距（>24 格）下真被当中转锚点。
 *  ⑧ 陷阱：按秒伤害、接触时长随档、满阈值引爆、阈值可调、踩中半径、鼠踩不受伤。
 *  ⑨ 自然局三张卡都被抽中、三种建筑都被造出来。
 *  ⑩ 卸载 fortify 不破核心。
 *
 * 测试纪律（沿用 card-liveness / farming 的教训）：
 *   - 只用 Sim 公开面 + debugForceCard，测试**不改源码**。
 *   - **debugForceCard 只 commit 卡，不执行 action**（systems.ts:112 的 commit 只写
 *     cardId/busyUntil/统计）——action 在下一次 behavior.update 才跑，所以
 *     debugForceCard 之后必须 step(1)。
 *   - **bootstrap 会额外出生鼠群**：`cfg.pawnCount` 只是下限，实际人口 =
 *     pawnCount + tuning.bootstrap.pawnCount(默认 4)（bootstrap.ts:27-31 在 init 里 spawnPawn）。
 *     需要精确人口的测试一律加 noBoot。
 *   - **陷阱测试不挂 bootstrap**：有鼠就有 fight 卡，猫会被近身补刀——实测
 *     pawnCount:0 时第 2 秒仍有一次 raid.ts:72 的 6 点伤害，引爆时序被搞脏。
 *   - 需要"敌人停在原地"时用 overrideTuning 把 cat 速度调成 0（数据表覆盖）。
 *   - 长距航点断言用**可复现的确定性样本**（见"哨塔航点"一节的实测依据）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import type { BuildingState } from '../sim/types';
import {
  K_STOCK_WOOD,
  K_TAG_FIRE,
  K_TAG_SHELTER,
  K_TAG_TRAP,
  K_TAG_TOWER,
  K_TAG_WALL,
  K_TAG_WAYPOINT,
  SER_BUILD,
} from '../mods/contracts';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { buildingPack } from '../mods/packs/building';
import { socialPack } from '../mods/packs/social';
import { raidPack } from '../mods/packs/raid';
import { bootstrapPack } from '../mods/packs/bootstrap';
import { fortifyPack } from '../mods/packs/fortify';
import type { Tuning } from '../sim/tuning';

/** 临时包：测试改数值一律走 overrideTuning。id 必须唯一——topoSort 对重复 id 抛错。 */
const mod = (id: string, fn: (t: Tuning) => void): ModPack => ({
  id,
  requires: [],
  apply(m) {
    m.overrideTuning(fn);
  },
});

/** 默认完整玩法清单（含 fortify）：真实装配，验证"自然局里三张卡真的被抽中"。 */
const PACKS: ModPack[] = [needsPack, gatheringPack, buildingPack, socialPack, raidPack, bootstrapPack, fortifyPack];

/** 关掉 bootstrap 的额外出生：需要精确人口的测试用它。 */
const noBoot = mod('mod-noboot', (t) => {
  t.bootstrap.pawnCount = 0;
});

/** 猫不动：speed=0 由数据表决定，不是测试手改坐标。 */
const catStatic = mod('mod-cat-static', (t) => {
  t.enemies['cat'].speed = 0;
});

/** 陷阱测试的最小装配：needs + building + raid + fortify。
 *  刻意**不挂 bootstrap**——它在 init 里额外出生鼠群（bootstrap.ts:27-31），
 *  有鼠就有 fight 卡，猫会被近身补刀，引爆时序就不再由陷阱系统单独决定。 */
const TRAP_PACKS: ModPack[] = [needsPack, buildingPack, raidPack, fortifyPack];

function sim(seed: number, extras: ModPack[] = [], pawnCount = 4): Sim {
  return new Sim({ seed, registry: ModRegistry.mountPacks([...PACKS, ...extras]), pawnCount });
}

const ofDef = (s: Sim, defId: string): BuildingState[] => [...s.buildingsAll()].filter((b) => b.defId === defId);

/** 测试夹具：在 (fx,fy) 附近环形找一块 w×h 全可站、且不压任何已有建筑的空地落子。
 *  参照 farming.test.ts:70 的写法（"不用建造卡，直接 addBuilding 架设测试夹具"）。 */
function placeNear(s: Sim, defId: string, fx: number, fy: number, maxR = 120): BuildingState | null {
  const f = s.world.footprint(defId);
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = fx + dx;
        const y = fy + dy;
        let free = true;
        for (let oy = 0; oy < f.h && free; oy++) {
          for (let ox = 0; ox < f.w && free; ox++) if (!s.world.canStand(x + ox, y + oy)) free = false;
        }
        if (free) {
          const b = s.addBuilding(defId, x, y);
          if (b) return b;
        }
      }
    }
  }
  return null;
}

describe('① 数据表：建筑种子与数值', () => {
  it('三建筑的定义（造价/hp/tags/passable/w×h）与设计一致', () => {
    const t = ModRegistry.mountPacks([buildingPack, fortifyPack]).effectiveTuning().buildings;

    const wall = t['wall']!;
    expect(wall.cost[K_STOCK_WOOD]).toBe(2);
    expect(wall.hp).toBe(40);
    expect(wall.passable).toBe(false); // 阻挡通行
    expect(wall.w).toBe(1);
    expect(wall.h).toBe(1);
    expect(wall.tags).toContain(K_TAG_WALL);

    const tower = t['tower']!;
    expect(tower.cost[K_STOCK_WOOD]).toBe(15);
    expect(tower.hp).toBe(120);
    expect(tower.passable).toBe(true); // 可站立
    expect(tower.w).toBe(2);
    expect(tower.h).toBe(2);
    expect(tower.tags).toContain(K_TAG_TOWER);
    expect(tower.tags).toContain(K_TAG_WAYPOINT); // 航点身份
    expect(tower.tags).toContain(K_TAG_SHELTER);
    // 语义污染防线：哨塔不是火，不能混进 cooking/sleep 的 nearestBuildingByTag('fire')
    expect(tower.tags).not.toContain(K_TAG_FIRE);

    const trap = t['trap']!;
    expect(trap.cost[K_STOCK_WOOD]).toBe(4);
    expect(trap.hp).toBe(30);
    expect(trap.passable).toBe(true); // 可踩
    expect(trap.w ?? 1).toBe(1);
    expect(trap.h ?? 1).toBe(1);
    expect(trap.tags).toContain(K_TAG_TRAP);
  });

  it('tuning.fortify 四个出厂值与设计一致', () => {
    const f = ModRegistry.mountPacks([buildingPack, fortifyPack]).effectiveTuning().fortify;
    expect(f.trapDmgPerSec).toBe(6);
    expect(f.trapHitRadius).toBe(0.6);
    expect(f.wallMinGap).toBe(1);
    expect(f.trapDurabilitySec).toBe(3);
  });

  it('三张建造卡是 SER_BUILD 系列，权重 3 / 4 / 2', () => {
    const reg = ModRegistry.mountPacks([buildingPack, fortifyPack]);
    for (const [id, w] of [['build_wall', 3], ['build_tower', 4], ['build_trap', 2]] as const) {
      const c = reg.cardById(id);
      expect(c, `注册了卡 ${id}`).toBeDefined();
      if (!c) continue;
      expect(c.series).toBe(SER_BUILD);
      expect(c.weight).toBe(w);
      expect(c.condition).toBeDefined();
      expect(c.action).toBeDefined();
    }
  });
});

describe('② 建造卡：意愿闸与落子', () => {
  it('无料时 condition 假；有料时真，落子成功才扣料，墙占格随即不可站', () => {
    const s = sim(42, [noBoot], 1);
    const p = [...s.pawns()][0];
    const card = s.reg.cardById('build_wall')!;

    // 木料不足：条件假
    s.stockpile[K_STOCK_WOOD] = 1;
    expect(card.condition!(p, s)).toBe(false);

    // 木料足够且世界上还没有墙：条件真
    const woodBefore = 10;
    s.stockpile[K_STOCK_WOOD] = woodBefore;
    expect(card.condition!(p, s)).toBe(true);

    // debugForceCard 只 commit，action 要等下一次 behavior.update 才执行
    expect(ofDef(s, 'wall')).toHaveLength(0);
    expect(s.debugForceCard(p.eid, 'build_wall')).toBe(true);
    expect(ofDef(s, 'wall')).toHaveLength(0);
    s.step(1);
    const walls = ofDef(s, 'wall');
    expect(walls).toHaveLength(1);
    expect(s.stockpile[K_STOCK_WOOD]).toBe(woodBefore - 2);
    // 建好的墙确实不可站（passable:false 的落地证据）
    expect(s.world.canStand(walls[0].pos.x, walls[0].pos.y)).toBe(false);
  });

  it('已有墙且身边无敌时不再想修墙；真有敌时才想修第二堵（threat gate 双向）', () => {
    const s = sim(1, [noBoot], 1);
    const p = [...s.pawns()][0];
    const card = s.reg.cardById('build_wall')!;
    s.stockpile[K_STOCK_WOOD] = 50;
    expect(card.condition!(p, s)).toBe(true); // 第一堵不设门槛
    expect(placeNear(s, 'wall', 10, 0)).not.toBeNull();
    // 有墙且身边 raid.senseRadius(18) 内无敌 → 不想（墙是迟滞工事不是装饰）
    expect(card.condition!(p, s)).toBe(false);
    // 有敌才想修第二堵
    s.spawnHostile('cat', Math.round(p.pos.x) + 3, Math.round(p.pos.y));
    expect(card.condition!(p, s)).toBe(true);
  });

  it('塔数达到人口上限（每 4 鼠 1 座）时不再想建塔；木料不够也不想', () => {
    const s = sim(1, [noBoot], 1);
    const p = [...s.pawns()][0];
    const card = s.reg.cardById('build_tower')!;

    s.stockpile[K_STOCK_WOOD] = 5; // < 15 造价：条件假
    expect(card.condition!(p, s)).toBe(false);

    s.stockpile[K_STOCK_WOOD] = 50;
    expect(card.condition!(p, s)).toBe(true); // 1 鼠上限 = max(1, ceil(1×0.25)) = 1
    expect(placeNear(s, 'tower', 10, 10)).not.toBeNull();
    expect(card.condition!(p, s)).toBe(false); // 已有 1 座 = 到顶
  });

  it('内核拒放时不扣料：陷阱间距被内核挡回 ⇒ 卡收工、木料原封', () => {
    /**
     * 为什么用 build_trap 而不是 build_wall：墙的 wallGap 预筛取
     * max(wallMinGap, build.minSpacing)，永远不会比内核宽松，所以墙的候选在
     * 包内就被滤掉了，走不到"内核拒放"这条分支。陷阱没有 gap 预筛，
     * 候选会真正交给内核判定——这里验的是 buildHere 的返回值检查（fortify.ts:24）。
     */
    const s = new Sim({
      seed: 1,
      registry: ModRegistry.mountPacks([...PACKS, noBoot, mod('mod-noroom', (t) => { t.build.searchRadius = 0; })]),
      pawnCount: 0,
    });
    expect(placeNear(s, 'trap', 5, 5)).not.toBeNull();
    const first = ofDef(s, 'trap')[0];
    // 让鼠站到与已有陷阱轴向距离 1 的格子上（内核 pad=4 必拒），searchRadius=0 ⇒ 只试这一格
    const p = s.pawn(s.spawnPawn(first.pos.x + 1, first.pos.y));
    expect(p).toBeDefined();
    s.stockpile[K_STOCK_WOOD] = 20;
    s.debugForceCard(p!.eid, 'build_trap');
    s.step(1);
    expect(ofDef(s, 'trap')).toHaveLength(1); // 没多出来
    expect(s.stockpile[K_STOCK_WOOD]).toBe(20); // 也没漏料
  });
});

describe('③ 阻挡：围墙真的挡住了通行', () => {
  it('墙占的格子不可站，通往它的路径不存在（同一格无墙时可站可达，对照内嵌）', () => {
    const s = sim(1, [noBoot], 1);
    const p = [...s.pawns()][0];
    // 找一格离鼠 ≥12 格的可站格当目标
    let target: [number, number] | null = null;
    for (let y = -30; y <= 30 && !target; y++) {
      for (let x = -30; x <= 30; x++) {
        if (Math.hypot(x - p.pos.x, y - p.pos.y) >= 12 && s.world.canStand(x, y)) {
          target = [x, y];
          break;
        }
      }
    }
    expect(target).not.toBeNull();
    const [tx, ty] = target!;
    expect(s.world.canStand(tx, ty)).toBe(true); // 对照：无墙时可站

    expect(s.addBuilding('wall', tx, ty)).not.toBeNull();
    expect(s.world.canStand(tx, ty)).toBe(false); // passable:false 生效
    // 目标不可站 ⇒ A* 无解
    expect(s.setPath(p, tx, ty)).toBe(false);
  });

  it('墙与墙的间距下限：近邻候选被拒，远了才落得下', () => {
    const s = sim(1, [noBoot], 1);
    expect(s.addBuilding('wall', 3, 3)).not.toBeNull();
    // build.minSpacing=5 ⇒ pad=4，轴向外扩 4 格内的同类候选全被拒
    for (const [x, y] of [[4, 3], [5, 3], [5, 5], [3, 7]] as const) {
      expect(s.addBuilding('wall', x, y), `墙 (${x},${y}) 距已有墙太近，应被内核拒`).toBeNull();
    }
    expect(s.addBuilding('wall', 10, 10)).not.toBeNull();
  });

  it('wallMinGap 被真正消费：调大它会把"内核本会放行"的候选挡掉', () => {
    /**
     * 构造：searchRadius=0 ⇒ findSpot 只试鼠自己那一个格子。
     * 先在内核放一堵墙，再让鼠站在与它边距正好 = build.minSpacing(5) 的格子上：
     *   内核规则（axial pad = minSpacing-1 = 4）会**接受**这个候选；
     *   包内预筛阈值 = max(wallMinGap, minSpacing)。
     *     wallMinGap=1 ⇒ 生效 5 ⇒ 5 < 5 假 ⇒ 不过滤 ⇒ 落得下（2 堵）；
     *     wallMinGap=6 ⇒ 生效 6 ⇒ 5 < 6 真 ⇒ 预筛挡掉 ⇒ 仍只有 1 堵。
     * 两个数值只差 wallMinGap，所以差异必然来自本包消费这个旋钮。
     */
    const run = (gap: number): number => {
      const s = new Sim({
        seed: 1,
        registry: ModRegistry.mountPacks([
          ...PACKS,
          noBoot,
          mod('gap' + gap, (t) => {
            t.fortify.wallMinGap = gap;
            t.build.searchRadius = 0;
          }),
        ]),
        pawnCount: 0,
      });
      // 找一对可站格：C 与 C+(5,0)
      let cx = 0;
      let cy = 0;
      for (let y = -20; y <= 20; y++) {
        for (let x = -20; x <= 20; x++) {
          if (s.world.canStand(x, y) && s.world.canStand(x + 5, y)) {
            cx = x;
            cy = y;
            y = 9999;
            break;
          }
        }
      }
      expect(s.addBuilding('wall', cx + 5, cy)).not.toBeNull();
      const eid = s.spawnPawn(cx, cy);
      s.stockpile[K_STOCK_WOOD] = 10;
      s.debugForceCard(eid, 'build_wall');
      s.step(1);
      return ofDef(s, 'wall').length;
    };
    expect(run(1)).toBe(2);
    expect(run(6)).toBe(1);
  });
});

describe('④ 航点：哨塔是 K_TAG_WAYPOINT，且不污染火桶', () => {
  it('哨塔进航点桶与塔桶，不进火桶', () => {
    const s = sim(2, [noBoot], 1);
    const tower = placeNear(s, 'tower', 20, 20);
    expect(tower).not.toBeNull();
    if (!tower) return;
    const key = (b: BuildingState) => `${b.pos.x},${b.pos.y}`;
    expect([...s.world.buildingsByTag(K_TAG_WAYPOINT)].map(key)).toContain(key(tower));
    expect([...s.world.buildingsByTag(K_TAG_TOWER)].map(key)).toContain(key(tower));
    // 不污染：火桶里没有哨塔（否则会在哨塔旁开火、按"火旁恢复"结算睡觉）
    expect([...s.world.buildingsByTag(K_TAG_FIRE)].map(key)).not.toContain(key(tower));
  });

  it(
    '长距（>24 格）下哨塔真的被当作中转锚点：路径可达、经过哨塔、且比直连更长',
    () => {
      /**
       * ---- 样本怎么选的（全部实测，不许拍脑袋）----
       * 目标：让"有塔"和"无塔"产生**可判定差异**。
       * setPath 的分叉在 isLong（距离 >24）：有锚点时走 planRoute（每段 1500 迭代预算），
       * 无锚点时走直连 findPath（预算 8000）。
       *
       * 直连 A* 在 seed=1 上到 (180,180) 需要展开 6684 个节点——超过 planRoute 的
       * 1500 预算，所以有塔时**只能**走分段中转；无塔的直连（8000 预算）能一路成功。
       * 于是差异 = "路径更长且经过哨塔"，而不是"从无解变有解"
       * （后者实测找不到样本：8000 预算覆盖了所有 <360 格的可达样本）。
       *
       * 中转点选 (130,50) 而不是直线中点 (90,90)：前者两段展开 500/462 均在预算内，
       * 且明显偏离直线 ⇒ 路径必然变长（分段最优 ≠ 全局直连最优）。
       * 中点 (90,90) 两段各需 1888，超预算，路由会失败——不能拿它当样本。
       *
       * 装配刻意不挂 bootstrap：不出生额外建筑/鼠 ⇒ anchors 为空，
       * "无塔"分支确实走的是 8000 预算的直连（而不是篝火锚点的分段）。
       */
      const reg = ModRegistry.mountPacks([needsPack, buildingPack, fortifyPack]);
      const s = new Sim({ seed: 1, registry: reg, pawnCount: 0 });
      expect(s.world.canStand(0, 0)).toBe(true);
      const p = s.pawn(s.spawnPawn(0, 0))!;
      const TX = 180;
      const TY = 180;
      expect(Math.abs(TX) + Math.abs(TY)).toBeGreaterThan(24); // 确实触发 isLong 分支

      // 无塔：直连（8000 预算）可达
      expect(s.setPath(p, TX, TY)).toBe(true);
      const lenDirect = p.path.length;
      expect(lenDirect).toBeGreaterThan(0);

      // 有塔：分段中转可达，路径更长且经过哨塔
      expect(s.addBuilding('tower', 130, 50)).not.toBeNull();
      expect(s.setPath(p, TX, TY)).toBe(true);
      expect(p.path.length).toBeGreaterThan(lenDirect);
      expect(p.path.some((n) => Math.hypot(n.x - 130, n.y - 50) < 2)).toBe(true);
    },
  );
});

describe('⑤ 陷阱：踩中伤害敌人、踩满引爆、鼠踩不受伤', () => {
  /** 陷阱世界标准夹具：猫停在陷阱正上方（speed=0 来自数据表），无鼠。 */
  function trapWorld(durability: number, catHp: number) {
    const s = new Sim({
      seed: 1,
      registry: ModRegistry.mountPacks([
        ...TRAP_PACKS,
        mod('mod-trap', (t) => {
          t.enemies['cat'].speed = 0;
          t.enemies['cat'].hp = catHp;
          t.fortify.trapDurabilitySec = durability;
        }),
      ]),
      pawnCount: 0,
    });
    const h = s.spawnHostile('cat', 5, 5);
    expect(s.addBuilding('trap', 5, 5)).not.toBeNull();
    return { s, h };
  }

  it('踩中按秒扣血：6 点/秒累积，跨 tick 接触时长落在 ctx.scratch 上', () => {
    const { s, h } = trapWorld(3, 24);
    s.step(1);
    expect(h.hp).toBe(24 - 6); // 1 秒 × 6 dps
    s.step(1);
    expect(h.hp).toBe(24 - 12); // 累积 2 秒 × 6 dps
    // 陷阱还在（未引爆）
    expect(ofDef(s, 'trap')).toHaveLength(1);
    // 跨 tick 状态真的落在 scratch（随档、按建筑 id 为键，不是闭包）
    const key = Object.keys(s.scratch).find((k) => k.startsWith('fortify.trapHit.'));
    expect(key).toBeDefined();
    expect(s.scratch[key!]).toBeGreaterThan(0);
  });

  it('累积接触满 trapDurabilitySec(3s) 后引爆：建筑移除、敌人掉血、scratch 无残留', () => {
    const { s, h } = trapWorld(3, 24);
    for (let i = 1; i <= 2; i++) {
      s.step(1);
      expect(ofDef(s, 'trap'), `第 ${i} 秒还没到引爆时长`).toHaveLength(1);
    }
    s.step(1); // 第 3 秒：接触时长到 3 ⇒ 引爆
    expect(ofDef(s, 'trap')).toHaveLength(0);
    // 引爆(3s)比磨死(24hp ÷ 6dps = 4s)先到：猫还活着，一次性的陷阱不会"磨完才炸"
    expect(h.hp).toBe(24 - 3 * 6);
    expect(h.hp).toBeGreaterThan(0);
    expect(Object.keys(s.scratch).filter((k) => k.startsWith('fortify.trapHit.'))).toHaveLength(0);
  });

  it('引爆时长是独立旋钮：调长后踩同样久不炸，敌人可继续扛', () => {
    const { s, h } = trapWorld(5, 60); // 猫更耐打，才能活到第 5 秒看引爆
    for (let i = 1; i <= 4; i++) {
      s.step(1);
      expect(ofDef(s, 'trap'), `第 ${i} 秒（<5s）不应引爆`).toHaveLength(1);
    }
    expect(h.hp).toBe(60 - 4 * 6); // 4 秒 × 6 dps
    s.step(1);
    expect(ofDef(s, 'trap')).toHaveLength(0); // 第 5 秒引爆
    expect(h.hp).toBe(60 - 5 * 6); // 敌人还活着 ⇒ 引爆阈值与伤害阈值互相独立
  });

  it('踩中半径生效：距离 > trapHitRadius(0.6) 不算踩中', () => {
    for (const [tx, ty] of [[6, 5], [6, 6]] as const) {
      const s = new Sim({ seed: 1, registry: ModRegistry.mountPacks([...TRAP_PACKS, catStatic]), pawnCount: 0 });
      const h = s.spawnHostile('cat', 5, 5);
      // 正交邻格中心距 = 1.0，对角邻格 = √2 ≈ 1.41，都 > 0.6
      expect(s.addBuilding('trap', tx, ty)).not.toBeNull();
      s.step(1);
      expect(h.hp).toBe(24); // 没掉血
    }
  });

  it('鼠踩陷阱不受伤：陷阱正在引爆敌人时，同一格上的鼠一滴血不掉', () => {
    /**
     * 猫被调成不掉血（dmg=0）且更耐打，于是猫只可能死于陷阱，
     * 而陷阱的伤害路径只有一条 ctx.damageHostile —— 全程站在陷阱上的鼠 hp 恒满。
     */
    const s = new Sim({
      seed: 1,
      registry: ModRegistry.mountPacks([
        ...TRAP_PACKS,
        mod('mod-pawn-on-trap', (t) => {
          t.enemies['cat'].speed = 0;
          t.enemies['cat'].dmg = 0;
          t.enemies['cat'].hp = 60;
        }),
      ]),
      pawnCount: 0,
    });
    expect(s.addBuilding('trap', 5, 5)).not.toBeNull();
    const h = s.spawnHostile('cat', 5, 5);
    const p = s.pawn(s.spawnPawn(5, 5))!; // 陷阱 passable:true，鼠可以站上去
    expect(p.hp).toBe(p.maxHp);
    for (let i = 0; i < 3; i++) s.step(1);
    expect(ofDef(s, 'trap')).toHaveLength(0); // 陷阱确实引爆了 ⇒ 系统在工作
    expect(h.hp).toBeLessThan(h.maxHp); // 敌人确实掉了血
    expect(p.hp).toBe(p.maxHp); // 而踩在同一格上的鼠一滴血没掉
  });
});

describe('⑥ 自然局：三张建造卡都被抽中、三种建筑都被造出来', () => {
  it('5 seed × 600 tick，build_wall / build_tower / build_trap 各至少被抽中 1 次', () => {
    for (const seed of [42, 7, 99, 2026, 8888]) {
      const s = new Sim({ seed, registry: ModRegistry.mountPacks(PACKS), pawnCount: 4 });
      for (let t = 0; t < 600; t++) s.step(1);
      const uses: Record<string, number> = {};
      for (const p of s.pawns()) for (const [k, v] of Object.entries(p.uses)) uses[k] = (uses[k] ?? 0) + v;
      for (const id of ['build_wall', 'build_tower', 'build_trap']) {
        expect(uses[id] ?? 0, `seed ${seed}：卡 ${id} 从未被抽中 = 死代码`).toBeGreaterThan(0);
      }
      // 抽中 ≠ 造出来（落子可能因间距失败），世界里也确实造出了三种防御建筑
      for (const id of ['wall', 'tower', 'trap']) {
        expect(ofDef(s, id).length, `seed ${seed}：没有 ${id} 被造出来`).toBeGreaterThan(0);
      }
    }
  });
});

describe('⑦ 卸载 fortify 不破坏核心', () => {
  it('不挂 fortify 的 600 tick 自然局照跑：无防御卡、无 fortify 状态、核心有产出', () => {
    const reg = ModRegistry.mountPacks([needsPack, gatheringPack, buildingPack, socialPack, raidPack, bootstrapPack]);
    const s = new Sim({ seed: 42, registry: reg, pawnCount: 4 });
    for (let t = 0; t < 600; t++) s.step(1);
    // 卸载语义：没有三张卡、没有三种建筑定义
    expect(s.reg.cardById('build_wall')).toBeUndefined();
    expect(s.reg.cardById('build_tower')).toBeUndefined();
    expect(s.reg.cardById('build_trap')).toBeUndefined();
    expect(s.tuning.buildings['wall']).toBeUndefined();
    // 核心照跑：有存活、有木料、有建筑
    expect([...s.pawns()].length).toBeGreaterThan(0);
    expect(s.stockpile[K_STOCK_WOOD] ?? 0).toBeGreaterThan(0);
    expect([...s.buildingsAll()].length).toBeGreaterThan(0);
    // fortify 数值无人消费：scratch 里不出现 fortify.* 键
    expect(Object.keys(s.scratch).filter((k) => k.startsWith('fortify.'))).toHaveLength(0);
  });
});
