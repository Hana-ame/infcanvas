/**
 * client-view.test.ts —— 视图层纯逻辑单测：inspect 属性卡语义（本地/远程同构，
 * 这里以 LocalView 为准锁行为；零 DOM/零 Pixi 依赖，node 环境可跑）。
 *
 * R3-HUD 追加：锁新增的 HUD 汇总面（colony）与详情面（inspectPawn/Building/Hostile）——
 * 这些面是 HUD 面板的唯一数据来源，面本身错了界面就会显示错的"世界事实"，
 * 所以与 inspect 同级锁语义。其中「与 RemoteSim 同构」由 hud-faces-isomorphic.test.ts
 * 用同一组断言跑两个实现来保证（不能只测本地，否则联机漂移无人发现）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { LocalView } from '../client/local-view';
import { RemoteSim } from '../client/remote';
import { HUD_SCRATCH_KEYS, type FullState } from '../shared/protocol';
import type { BuildingState, PawnState } from '../sim/types';
import { snapshotOf } from '../sim';

function makeView(seed = 3): { view: LocalView; sim: Sim } {
  const sim = new Sim({ seed, registry: ModRegistry.default() });
  return { view: new LocalView(sim), sim };
}

describe('悬停属性卡 inspect', () => {
  it('草地：地形名/可通行/坐标', () => {
    const { view, sim } = makeView();
    // 安全区内 (x+y)%5==0 是泥地——扫描找一块真实草地
    let g = { x: 1, y: 0 };
    for (let i = 0; i < 10; i++) {
      if (sim.world.tileAt(g.x + i, g.y) === 'grass') {
        g = { x: g.x + i, y: g.y };
        break;
      }
    }
    const info = view.inspect(g.x, g.y);
    expect(info.terrainId).toBe('grass');
    expect(info.terrainName).toBe('草地');
    expect(info.z).toBeGreaterThanOrEqual(0);
    expect(info.standable).toBe(true);
    expect(info.treeCanopy).toBe(false);
    expect(info.feature).toBeNull();
    expect(info.buildingName).toBeNull();
  });

  it('水域：不可通行且中文名正确', () => {
    const { view, sim } = makeView();
    // 找一格真实水域
    let found: { x: number; y: number } | null = null;
    outer: for (let r = 7; r < 80; r += 2) {
      for (let y = -r; y <= r; y += 2) {
        for (let x = -r; x <= r; x += 2) {
          if (sim.world.tileAt(x, y) === 'water') {
            found = { x, y };
            break outer;
          }
        }
      }
    }
    expect(found).not.toBeNull();
    const info = view.inspect(found!.x, found!.y);
    expect(info.terrainId).toBe('water');
    expect(info.terrainName).toBe('水域');
    expect(info.liquid).toBe(true);
    expect(info.standable).toBe(false); // 水面无法立足（与攀爬无关）
  });

  it('浆果丛：特征标签带余量；大树树冠格标注 treeCanopy', () => {
    const { view, sim } = makeView();
    // 找真实浆果丛与真实大树（多格化后的世界）
    let berry: { x: number; y: number } | null = null;
    let treeAnchor: { x: number; y: number } | null = null;
    outer: for (let r = 7; r < 60; r++) {
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const f = sim.world.featureAt(x, y);
          if (!berry && f?.kind === 'berry') berry = { x, y };
          if (!treeAnchor && f?.kind === 'tree') treeAnchor = { x, y };
          if (berry && treeAnchor) break outer;
        }
      }
    }
    expect(berry).not.toBeNull();
    const bi = view.inspect(berry!.x, berry!.y);
    expect(bi.feature?.kind).toBe('berry');
    expect(bi.feature!.label).toContain('浆果丛');

    expect(treeAnchor).not.toBeNull();
    // 树冠覆盖格（锚点右下邻格）：featureAt 为 null（锚点才是代表），但 treeCanopy 标注
    const ci = view.inspect(treeAnchor!.x + 1, treeAnchor!.y + 1);
    expect(ci.treeCanopy).toBe(true);
    expect(ci.standable).toBe(false); // 树冠不可立足
    // 锚点格本身：显示大树特征信息
    const ai = view.inspect(treeAnchor!.x, treeAnchor!.y);
    expect(ai.feature?.label).toContain('大树');
  });

  it('建筑格：显示建筑名（篝火）', () => {
    const { view, sim } = makeView();
    const fire = [...sim.world.buildings.values()].find(
      (b) => sim.tuning.buildings[b.defId].tags.includes('fire'),
    )!;
    expect(fire).toBeDefined();
    const info = view.inspect(fire.pos.x, fire.pos.y);
    expect(info.buildingName).toBe('篝火');
    expect(info.standable).toBe(true); // 篝火不挡路
  });
});

// =====================================================================
// R3-HUD：HUD 汇总面 colony() / 详情面 inspect*()
//
// 为什么这些面要单独锁：HUD 的每个面板都直接渲染它们，面错了界面就在撒谎
// （比如"敌袭压力 0%"其实是没有 raid 包、或"同类共 0 座"其实是不存在这座建筑）。
// 它们是**纯展示模型**——不产生副作用、不写任何状态，断言可以全用等值比较。
// =====================================================================

describe('HUD 汇总面 colony()（R3-HUD）', () => {
  it('人口/均值需求/血量：与直接遍历 Sim 的原始数据一致', () => {
    const { view, sim } = makeView();
    for (let i = 0; i < 40; i++) sim.step(0.25); // 跑一点时间让需求分散开（不分散则均值无意义）
    const c = view.colony();

    // 期望值由 Sim 原始数据独立算出——不复用被测代码的算法，避免"自证"
    const pawns = [...sim.pawns()];
    expect(c.pawnCount).toBe(pawns.length);
    const mean = (f: (p: PawnState) => number): number =>
      pawns.reduce((a, p) => a + f(p), 0) / Math.max(1, pawns.length);
    expect(c.avgNeeds.food).toBeCloseTo(mean((p) => p.needs.food), 6);
    expect(c.avgNeeds.rest).toBeCloseTo(mean((p) => p.needs.rest), 6);
    expect(c.avgNeeds.mood).toBeCloseTo(mean((p) => p.needs.mood), 6);
    expect(c.avgNeeds.san).toBeCloseTo(mean((p) => p.needs.san), 6);
    expect(c.avgHpPct).toBeCloseTo(mean((p) => (p.hp / p.maxHp) * 100), 6);
    // 需求是 0..100 的饱和值（不是百分比增长）——面板按这个刻度画条，锁住它
    for (const v of [c.avgNeeds.food, c.avgNeeds.rest, c.avgNeeds.mood, c.avgNeeds.san]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('空世界：人口 0、均值为 0，且**不是 NaN**（0/0 的经典坑）', () => {
    const { view, sim } = makeView();
    for (const p of [...sim.pawns()]) sim.killPawn(p.eid, '测试清空');
    const c = view.colony();
    expect(c.pawnCount).toBe(0);
    // NaN 会让面板写进 HTML 变成 "NaN%"，是玩家可见的破版——必须锁死
    expect(c.avgNeeds.food).toBe(0);
    expect(c.avgHpPct).toBe(0);
    expect(Number.isNaN(c.avgNeeds.food)).toBe(false);
    expect(Number.isNaN(c.avgHpPct)).toBe(false);
  });

  it('建筑按种类归并计数，含名称与燃料参数；同种建筑合并成一行', () => {
    const { view, sim } = makeView();
    // 放置点不能写死坐标：world.addBuilding 会做地形（可通行）/占位/同类间距判定，
    // 水面或树冠上会返回 null。改用**确定性扫描**找可建格（与 building 包的 findSpot 同法），
    // 顺带保证"建不起来时测试响亮失败"而不是算成"归并错"。
    const place = (defId: string, from: number): void => {
      let done = false;
      for (let r = 0; r < 60 && !done; r++) {
        for (let dy = -r; dy <= r && !done; dy++) {
          for (let dx = -r; dx <= r && !done; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (sim.world.addBuilding(defId, from + dx, from + dy)) done = true;
          }
        }
      }
      expect(done, `放不下建筑：${defId}`).toBe(true);
    };
    place('campfire', 30);
    const afterTwo = view.colony().buildingKinds.find((k) => k.defId === 'campfire')!.count;
    place('campfire', 60);
    place('hut', 100);
    const c = view.colony();

    // 断言用**增量**而不是绝对值：bootstrap 包开局已在原点立了一座篝火，
    // 写死 count=2 会把"开局那座"漏算（也解释了为什么这里不能用字面量）。
    const campfire = c.buildingKinds.find((k) => k.defId === 'campfire');
    expect(campfire?.count).toBe(afterTwo + 1); // 归并成一行（数量累加，不是多出一行）
    expect(campfire?.name).toBe('篝火');
    expect(campfire?.fuelSec).toBe(12); // 燃料节奏是面板要显示的关键信息
    const hut = c.buildingKinds.find((k) => k.defId === 'hut');
    expect(hut?.count).toBe(1);
    expect(hut?.fuelSec).toBeUndefined(); // 免维护的楼

    // 总数与原始表一致（防止"面板少算一座"这种最难察觉的错）
    const total = c.buildingKinds.reduce((a, k) => a + k.count, 0);
    expect(total).toBe([...sim.world.buildings.values()].length);
  });

  it('敌袭压力读 scratch 真实值，百分比钳制在 0..100，ETA 为非负估算', () => {
    const { view, sim } = makeView();
    const threshold = sim.tuning.raid.pressureThreshold;

    sim.scratch['raid.pressure'] = 0;
    expect(view.colony().raidPressure).toBe(0);
    sim.scratch['raid.pressure'] = threshold;
    expect(view.colony().raidPressure).toBeCloseTo(1, 6);
    // 超额（刷怪后可能只扣了一部分，或调表后阈值变小）必须钳制，HUD 进度条不能画到 100% 以外
    sim.scratch['raid.pressure'] = threshold * 3;
    expect(view.colony().raidPressure).toBe(1);

    // ETA 公式：(阈值 - 当前) / 速率，满阈值时为 0
    sim.scratch['raid.pressure'] = 0;
    const eta = view.colony().raidEtaSec!;
    expect(eta).toBeCloseTo(threshold / sim.tuning.raid.pressurePerSec, 6);
    expect(eta).toBeGreaterThan(0);
    sim.scratch['raid.pressure'] = threshold;
    expect(view.colony().raidEtaSec).toBe(0);
  });

  it('未挂 raid 包：压力为 null（面板据此**隐藏**威胁块，而不是显示假 0%）', () => {
    const sim = new Sim({ seed: 3, registry: ModRegistry.mountPacks([]) });
    const view = new LocalView(sim);
    expect(view.colony().raidPressure).toBeNull();
    expect(view.colony().raidEtaSec).toBeNull();
  });
});

describe('HUD 详情面 inspectPawn / inspectBuilding / inspectHostile（R3-HUD）', () => {
  it('鼠档案：需求/血量/当前卡/火堆距离，熟练与卡用次数按强度排序并截断', () => {
    const { view, sim } = makeView();
    const p = [...sim.pawns()][0];
    p.needs.food = 42;
    p.hp = p.maxHp * 0.5;
    p.cardId = 'eat';
    p.mastery = { gather_berry: { v: 55, t: 0 }, chop_tree: { v: 30, t: 0 }, wander: { v: 0.4, t: 0 }, sleep: { v: 88, t: 0 } };
    p.uses = { gather_berry: 12, chop_tree: 3 };

    const d = view.inspectPawn(p.eid)!;
    expect(d.eid).toBe(p.eid);
    expect(d.needs.food).toBe(42);
    expect(d.hpPct).toBeCloseTo(50, 6);
    expect(d.cardLabel).toBe('🍎吃饭'); // 卡 id 走客户端权威文案表，不显示裸 id
    expect(d.traitName).toBe(sim.tuning.traits[p.trait]?.name);

    // 熟练：v<1 的"抽过一次"不进表（噪声），按 v 降序
    expect(d.mastery.map((m) => m.cardId)).toEqual(['sleep', 'gather_berry', 'chop_tree']);
    expect(d.mastery[0].v).toBe(88);
    expect(d.mastery[0].label).toBe('😴睡觉'); // label 也走文案表
    // 卡用次数按次数降序
    expect(d.uses.map((u) => u.cardId)).toEqual(['gather_berry', 'chop_tree']);
    expect(d.uses[0].n).toBe(12);
  });

  it('鼠档案：列表上限 5 条（信息密度封顶——详情面板不能无限长）', () => {
    const { view, sim } = makeView();
    const p = [...sim.pawns()][0];
    const many: Record<string, { v: number; t: number }> = {};
    const uses: Record<string, number> = {};
    for (let i = 0; i < 9; i++) {
      many[`card_${i}`] = { v: 100 - i, t: 0 }; // 确定性排序：v 严格递减
      uses[`card_${i}`] = 9 - i;
    }
    p.mastery = many;
    p.uses = uses;
    const d = view.inspectPawn(p.eid)!;
    expect(d.mastery).toHaveLength(5);
    expect(d.uses).toHaveLength(5);
    expect(d.mastery[0].cardId).toBe('card_0'); // 截断保留的是最强的那几条
  });

  it('建筑档案：尺寸/耐久/造价/燃料节奏/同类总数；id 不存在返回 null', () => {
    const { view, sim } = makeView();
    // 同上：坐标要扫出来，写死会撞水面/树冠
    const place = (defId: string, from: number): void => {
      let done = false;
      for (let r = 0; r < 60 && !done; r++) {
        for (let dy = -r; dy <= r && !done; dy++) {
          for (let dx = -r; dx <= r && !done; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (sim.world.addBuilding(defId, from + dx, from + dy)) done = true;
          }
        }
      }
      expect(done, `放不下建筑：${defId}`).toBe(true);
    };
    place('hut', 12);
    const one = view.colony().buildingKinds.find((k) => k.defId === 'hut')!.count;
    place('hut', 50);
    const hut = [...sim.world.buildings.values()].find((b) => b.defId === 'hut')!;

    const d = view.inspectBuilding(hut.id)!;
    expect(d.name).toBe('棚屋');
    expect(d.w).toBe(2); // 占地尺寸此前完全不可见
    expect(d.h).toBe(2);
    expect(d.maxHp).toBe(sim.tuning.buildings.hut.hp);
    expect(d.cost).toEqual(sim.tuning.buildings.hut.cost);
    expect(d.tags).toContain('shelter');
    expect(d.sameKindCount).toBe(one + 1); // "我有几座棚屋"是玩家反复要问的问题（用增量避开开局篝火干扰）
    expect(view.inspectBuilding('不存在的建筑id')).toBeNull();
  });

  it('敌袭档案：名字/血量/最近鼠距离/警戒判定；id 不存在返回 null', () => {
    const { view, sim } = makeView();
    const p = [...sim.pawns()][0];
    // 放在鼠旁边 → 必定 engaging（距离 0 << senseRadius）
    const h = sim.spawnHostile('cat', Math.round(p.pos.x) + 1, Math.round(p.pos.y));
    const d = view.inspectHostile(h.id)!;
    expect(d.name).toBe('野猫');
    expect(d.hp).toBe(h.hp);
    expect(d.maxHp).toBe(h.maxHp);
    expect(d.distToNearestPawn).toBeLessThanOrEqual(2);
    expect(d.engaging).toBe(true);
    expect(view.inspectHostile(99999)).toBeNull();
  });

  it('敌袭档案：鼠群全灭时距离为 -1（面板显示 "—"，不是 Infinity）', () => {
    const { view, sim } = makeView();
    const h = sim.spawnHostile('cat', 50, 50);
    for (const p of [...sim.pawns()]) sim.killPawn(p.eid, '测试清空');
    const d = view.inspectHostile(h.id)!;
    // Infinity 直接进 HTML 会显示 "Infinity 格"，是玩家可见的破版
    expect(d.distToNearestPawn).toBe(-1);
    expect(Number.isFinite(d.distToNearestPawn)).toBe(true);
    expect(d.engaging).toBe(false);
  });

  it('鼠档案：查不存在的 eid 返回 null（选中后该鼠死掉，面板要能优雅消失）', () => {
    const { view } = makeView();
    expect(view.inspectPawn(99999)).toBeNull();
  });

  it('鼠档案：附近无火时 nearFireDist 为 null（面板显示"附近无火"而非 NaN）', () => {
    const { view, sim } = makeView();
    for (const b of [...sim.world.buildings.values()]) sim.world.removeBuilding(b.id);
    const p = [...sim.pawns()][0];
    const d = view.inspectPawn(p.eid)!;
    expect(d.nearFireDist).toBeNull();
  });
});

/**
 * 「双模同脸」是项目的既有纪律：HUD 面板不能只在本地模式能看。
 * 同一份 Sim 快照喂给 LocalView 与 RemoteSim，两者的 HUD 面必须**逐字段相等**。
 * 只测本地会漏掉"联机漂移"这类只在真实对局里才暴露的 bug。
 */
describe('HUD 面：LocalView 与 RemoteSim 同构（R3-HUD 双模纪律）', () => {
  function fullStateOf(sim: Sim): FullState {
    const snap = snapshotOf(sim);
    return {
      time: snap.time,
      stockpile: snap.stockpile,
      pawns: snap.pawns,
      hostiles: snap.hostiles,
      buildings: snap.world.buildings,
      events: snap.events,
      world: snap.world,
      techs: snap.techs,
      techFragments: snap.techFragments,
      hudScratch: Object.fromEntries(
        HUD_SCRATCH_KEYS.filter((k) => sim.scratch[k] !== undefined).map((k) => [k, sim.scratch[k]]),
      ),
    };
  }

  function bothViews(seed: number, steps: number): { local: LocalView; remote: RemoteSim; sim: Sim } {
    const sim = new Sim({ seed, registry: ModRegistry.default() });
    for (let i = 0; i < steps; i++) sim.step(0.25);
    const local = new LocalView(sim);
    const remote = new RemoteSim();
    remote.handleForTest({
      t: 'welcome',
      d: { ...fullStateOf(sim), seed: sim.world.seed, tuning: structuredClone(sim.tuning) },
    });
    return { local, remote, sim };
  }

  it('colony() 逐字段相等（人口/均值/建筑/敌人数/压力/ETA）', () => {
    for (const seed of [3, 42, 777]) {
      const { local, remote, sim } = bothViews(seed, 120);
      // 让敌袭系统跑起来，压力键才有真实值可对比
      expect(sim.scratch['raid.pressure']).toBeGreaterThan(0);
      expect(local.colony()).toEqual(remote.colony());
    }
  });

  it('inspectPawn / inspectBuilding / inspectHostile 逐字段相等', () => {
    const { local, remote, sim } = bothViews(42, 200);
    // 覆盖三类详情对象：鼠、建筑、敌袭单位
    const pawn = [...sim.pawns()][0];
    const building: BuildingState | undefined = [...sim.world.buildings.values()][0];
    const hostile = [...sim.hostiles()][0];

    expect(local.inspectPawn(pawn.eid)).toEqual(remote.inspectPawn(pawn.eid));
    if (building) expect(local.inspectBuilding(building.id)).toEqual(remote.inspectBuilding(building.id));
    if (hostile) expect(local.inspectHostile(hostile.id)).toEqual(remote.inspectHostile(hostile.id));
    // 不存在的 id 两边都返回 null（不能一边 null 一边 undefined —— 面板的空判断会分歧）
    expect(local.inspectPawn(99999)).toBeNull();
    expect(remote.inspectPawn(99999)).toBeNull();
  });

  it('科技面仍然同构（R2-1 面不能被本轮改动碰坏）', () => {
    const { local, remote, sim } = bothViews(42, 400);
    expect(local.techProgress()).toEqual(remote.techProgress());
    expect(sim.techFragments).toBeDefined();
  });
});
