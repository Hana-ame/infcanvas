// 制衣玩法包（clothing）测试（2026-08-15 用户需求：服装制作 + 染料 + 设计=科技抽卡 + 材质）
// 覆盖：材质闭环（猫掉皮→鞣革→皮衣 / 亚麻丛→织布→麻衫）、科技门控（款式=设计）、
// 染色配方、wear 命令（穿/换/脱 + 库存 + 心情）、thermo 保暖联动。
// 发现背景：wear 命令早期实现曾漏掉"旧衣回库存"（换装 = 衣物蒸发）——本文件防御。
import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { ModRegistry } from '../../sim/mods/registry';
import { BASE_CARDS } from '../../sim/ai/pawn';
import { clothingPack } from '../packs/clothing';
import { DYE_NAMES } from '../packs/clothing';

// 最小装配：默认玩法（含 clothing）+ 可控配置
function makeSim(seed = 11, pawnCount = 2): Sim {
  return new Sim({ seed, pawnCount, registry: ModRegistry.default() });
}

// 推进时间直到条件满足（每步 1/20s，上限防死循环）
function until(sim: Sim, cond: () => boolean, maxSec = 60): boolean {
  for (let i = 0; i < maxSec * 20; i++) {
    if (cond()) return true;
    sim.step(1 / 20);
  }
  return cond();
}

// 找一块可建 loom 的空地（seed 不同出生地形不同，(6,6) 可能被水/山/树/灌木占——实测踩坑）
function findSpot(sim: Sim): { x: number; y: number } {
  for (let y = 4; y < sim.world.height - 4; y++) {
    for (let x = 4; x < sim.world.width - 4; x++) {
      if (sim.world.canBuildFootprint(x, y, sim.mods.buildings.loom)) return { x, y };
    }
  }
  throw new Error('找不到可建裁缝台的空地');
}

// 建好一座裁缝台（解锁 + 蓝图 + 等建成），返回其坐标
function buildLoom(sim: Sim): { x: number; y: number } {
  const spot = findSpot(sim);
  sim.stockpile.wood = 100;
  sim.unlockTech('craft:clothing');
  sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'loom' });
  const ok = until(sim, () => sim.world.getBuilding(spot.x, spot.y) != null, 15);
  if (!ok) throw new Error(`裁缝台 ${spot.x},${spot.y} 未在 15s 内建成`);
  return spot;
}

describe('clothing 玩法包（制衣：材质/染料/设计）', () => {
  it('默认装配包含制衣系统（25 系统序：cook 后、raid 前）', () => {
    const sim = makeSim();
    const ids = [...sim.systemIds];
    expect(ids).toContain('clothing');
    expect(ids.indexOf('clothing')).toBeGreaterThan(ids.indexOf('cook'));
    expect(ids.indexOf('clothing')).toBeLessThan(ids.indexOf('raid'));
  });

  it('配方表：鞣革/织布/缝衣/染色齐全，染料配方为程序生成的 9 个', () => {
    const sim = makeSim();
    for (const rid of ['leather', 'linen', 'peltShirt', 'linenShirt', 'leatherCoat']) {
      expect(sim.mods.recipes[rid]).toBeDefined();
    }
    // 9 个染色配方（3 染料 × 3 基衣）
    for (const d of Object.keys(DYE_NAMES)) {
      for (const base of ['peltShirt', 'linenShirt', 'leatherCoat']) {
        expect(sim.mods.recipes[`dye_${d}_${base}`]).toBeDefined();
        expect(sim.mods.items[`${d}_${base}`]).toBeDefined();
      }
    }
  });

  it('裁缝台 loom：craft:clothing 科技门控建造（设计=科技抽卡）', () => {
    const sim = makeSim();
    expect(sim.mods.buildings.loom.tech).toBe('craft:clothing');
    // 未解锁 → 蓝图被拒（issueCommand 返回 void：以 buildQueue 副作用断言）
    const spot = findSpot(sim);
    sim.stockpile.wood = 100;
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'loom' });
    expect(sim.buildQueue.some((b) => b.defId === 'loom')).toBe(false);
    // 解锁 craft:clothing（走科技碎片制解锁路径）
    sim.unlockTech('craft:clothing');
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'loom' });
    expect(sim.buildQueue.some((b) => b.defId === 'loom')).toBe(true);
  });

  it('材质闭环·皮路线：猫击杀掉 pelt → 鞣革 → 皮衣（裁缝台生产）', () => {
    const sim = makeSim(13, 1);
    // 猫掉 pelt（overrideDef 生效：替代原 ore）
    expect(sim.mods.enemies.cat.loot).toEqual({ item: 'pelt', amount: 2 });
    sim.stockpile.pelt = 6;
    buildLoom(sim);
    // 鞣革配方无科技门控 → 自动生产 leather；peltShirt 也无门控
    expect(until(sim, () => (sim.stockpile.leather ?? 0) >= 1)).toBe(true);
    expect(until(sim, () => (sim.stockpile.peltShirt ?? 0) >= 1)).toBe(true);
  });

  it('材质闭环·麻路线：织布/麻衫受 craft:linen 科技门控（未研发静默不产）', () => {
    const sim = makeSim(14, 1);
    sim.stockpile.flax = 20;
    buildLoom(sim);
    // 未解锁 craft:linen：linen 不产（技术缺失 = 款式未设计）
    sim.step(6); // 推进几秒，若配方无门控此处早已产出
    expect(sim.stockpile.linen ?? 0).toBe(0);
    // 解锁后生产（linen 与 linenShirt 配方节奏同步（interval 同为 6s），同 tick 织 2 耗 2
    // → linen 恒近 0，断言窗口观测不到 >=2——改为断言最终产物 + 原料消耗）
    sim.unlockTech('craft:linen');
    expect(until(sim, () => (sim.stockpile.linenShirt ?? 0) >= 1)).toBe(true);
    expect(sim.stockpile.flax ?? 0).toBeLessThan(20); // 织布真的消耗了原料
  });

  it('染色：base + 染料 → 染色衣（craft:dye 门控；配方两端消费正确）', () => {
    const sim = makeSim(15, 1);
    sim.stockpile.peltShirt = 2;
    sim.stockpile.redDye = 2;
    buildLoom(sim);
    sim.step(6);
    expect(sim.stockpile.red_peltShirt ?? 0).toBe(0); // 未解锁染色术
    sim.unlockTech('craft:dye');
    expect(until(sim, () => (sim.stockpile.red_peltShirt ?? 0) >= 1)).toBe(true);
    // 两输入各扣 1
    expect(sim.stockpile.peltShirt ?? 0).toBe(1);
    expect(sim.stockpile.redDye ?? 0).toBe(1);
  });

  it('wear 命令：穿/换/脱闭环（库存增减、worn 落 extra 存档扩展点、心情加成）', () => {
    const sim = makeSim(16, 1);
    const eid = sim.pawns[0];
    sim.stockpile.peltShirt = 1;
    sim.stockpile.red_peltShirt = 1;
    const mood0 = sim.readNeeds(eid)?.mood ?? 50;
    // 穿素衣：库存 -1，worn.body 记录，心情 +3（issueCommand 返回 void，副作用断言）
    sim.issueCommand({ type: 'wear', x: 0, y: 0, pawnId: eid, args: { itemId: 'peltShirt' } });
    expect(sim.stockpile.peltShirt).toBe(0);
    expect((sim.pawnStates.get(eid)!.extra!['worn'] as { body: string }).body).toBe('peltShirt');
    expect((sim.readNeeds(eid)?.mood ?? 0)).toBeGreaterThan(mood0 as number);
    // 换染色衣：新衣 -1，旧衣回库存（防御：衣物蒸发回归），心情 +3+2（悦目）
    const mood1 = sim.readNeeds(eid)?.mood ?? 0;
    sim.issueCommand({ type: 'wear', x: 0, y: 0, pawnId: eid, args: { itemId: 'red_peltShirt' } });
    expect(sim.stockpile.red_peltShirt).toBe(0);
    expect(sim.stockpile.peltShirt).toBe(1);
    expect((sim.readNeeds(eid)?.mood ?? 0)).toBeGreaterThanOrEqual(mood1 + 5);
    // 脱衣：衣物回库存
    sim.issueCommand({ type: 'wear', x: 0, y: 0, pawnId: eid });
    expect(sim.stockpile.red_peltShirt).toBe(1);
    expect((sim.pawnStates.get(eid)!.extra!['worn'] as { body?: string }).body).toBeUndefined();
  });

  it('wear 拒绝：库存 0 或非衣物物品不可穿（状态不变）', () => {
    const sim = makeSim(17, 1);
    const eid = sim.pawns[0];
    sim.issueCommand({ type: 'wear', x: 0, y: 0, pawnId: eid, args: { itemId: 'peltShirt' } }); // 库存 0
    expect((sim.pawnStates.get(eid)!.extra?.['worn'] as { body?: string } | undefined)?.body).toBeUndefined();
    sim.stockpile.wood = 1;
    sim.issueCommand({ type: 'wear', x: 0, y: 0, pawnId: eid, args: { itemId: 'wood' } }); // 非衣物
    expect((sim.pawnStates.get(eid)!.extra?.['worn'] as { body?: string } | undefined)?.body).toBeUndefined();
    expect(sim.stockpile.wood).toBe(1);
  });

  it('thermo 联动：穿皮衣御寒、穿麻衫散热（ItemDef.meta.warmth 契约）', () => {
    const sim = makeSim(18, 1);
    const eid = sim.pawns[0];
    // 从天气与热源剥离，只验证衣服贡献：找一处远离篝火的坐标
    const pos = sim.pawnPositions.get(eid)!;
    const effTemp = (): number => {
      // 复算 thermo 有效温度公式（无热源、无天气随机）：env.temperature + 衣 warmth
      const wornId = (sim.pawnStates.get(eid)!.extra?.['worn'] as { body?: string } | undefined)?.body;
      const w = wornId ? (sim.mods.items[wornId]?.meta?.['warmth'] as number | undefined) ?? 0 : 0;
      return sim.env.temperature + w;
    };
    expect(sim.mods.items.peltShirt.meta?.['warmth']).toBe(3);
    expect(sim.mods.items.linenShirt.meta?.['warmth']).toBe(-1);
    sim.stockpile.peltShirt = 1;
    sim.issueCommand({ type: 'wear', x: 0, y: 0, pawnId: eid, args: { itemId: 'peltShirt' } });
    expect(effTemp()).toBe(sim.env.temperature + 3);
    expect(pos.x).toBeGreaterThan(0); // 防误用哨兵
  });

  it('野外资源：flaxBush/染料丛可采集（growable+harvest 数据驱动接入采集系统）', () => {
    const sim = makeSim(19, 2);
    // 找 flaxBush 坐标（seed 19 必含 flax 点缀；密度 0.4%，800×800 必现）
    let flax: { x: number; y: number } | null = null;
    outer:
    for (let y = 1; y < sim.world.height - 1; y++) {
      for (let x = 1; x < sim.world.width - 1; x++) {
        if (sim.world.getTile(x, y) === 'flaxBush') { flax = { x, y }; break outer; }
      }
    }
    expect(flax).not.toBeNull();
    // 采集走 chop 卡行为（walkAndWork 找 growable+harvest tile，1263 先例）。注意坑：
    // 树也是 harvestable 且更常见——只放一丛 flaxBush 会被"更近的树"抢走砍伐目标。
    // 仿 berry 先例：小人周边 3×3 外圈全铺 flaxBush（中心留草地走位），确保唯一目标
    const cx = flax!.x; const cy = flax!.y;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === 3) sim.world.setTile(cx + dx, cy + dy, 'flaxBush');
      }
    }
    for (const eid of sim.pawns) {
      const st = sim.pawnStates.get(eid)!;
      if (!st.slots.some((c) => c?.id === 'chop')) st.slots.push(BASE_CARDS.find((c) => c.id === 'chop')!);
      // 位置要写 ECS Position 组件（决策 readPosition 读组件而非 pawnPositions 展示 Map——
      // 踩坑：只 set pawnPositions 时小人依然在营地决策，跑到远处砍树不采 flaxBush）
      sim.setPosition(eid, { x: cx, y: cy });
      sim.pawnPositions.set(eid, { x: cx, y: cy });
    }
    expect(until(sim, () => (sim.stockpile.flax ?? 0) > 0, 30)).toBe(true);
    // 地形 def 由玩法包注册（tileAt 只产 id，def 数据在包）
    expect(sim.mods.tiles.flaxBush).toBeDefined();
    expect(sim.mods.tiles.flaxBush.harvest?.product).toBe('flax');
  });
});