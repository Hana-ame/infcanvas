/**
 * p2-interact.test.ts —— P2 环境交互 + NPC 对话单测（2026-10-13）。
 *
 * 设计口径（KB proj-infcanvas-direct-control-proposal-2026-10-13 五-3 / 六-②）：
 *  - 成功率表 tuning.successRate（攻击/拾取/对话等；**移动本体无成功率**）；
 *  - interact proximity 解析顺序 NPC → 特征拾取 → 建筑使用/传送（复用 takeOne/
 *    featureRect/buildingsByTag，P1 调研确认可复用）；
 *  - 对话：选项 = 玩家选择（给玩家里子）；效果走现有 gacha 机制（techFragment 走
 *    科技抽卡池 = 任务给"抽卡"面子）；rollSuccess 选项过 successRate.dialogue
 *    （失败 = NPC 拒绝，效果不生效并关对话）。
 *
 * 与自主局零交集：interact/对话不进 behavior 抽卡路径、不占 cardId/busyUntil，
 * golden 指纹不受影响。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { buildingPack } from '../mods/packs/building';

/** 空装配内核 Sim（无玩法包、无出生鼠）——默认 tuning 仍含 successRate/dialogues。 */
function emptySim(seed = 42): Sim {
  return new Sim({ seed, registry: new ModRegistry(), pawnCount: 0 });
}

/** 找「可拾取特征 + 周边可立足格」：interact 拾取测试的固定地形锚点。 */
function findPickupSpot(s: Sim): { x: number; y: number; kind: 'berry' | 'tree' } {
  for (let y = -40; y <= 40; y++) {
    for (let x = -40; x <= 40; x++) {
      const f = s.featureAt(x, y);
      if (!f) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const px = x + dx;
        const py = y + dy;
        if (s.world.canStand(px, py)) return { x: px, y: py, kind: f.kind };
      }
    }
  }
  throw new Error(`测试数据：seed=${s.world.seed} 下找不到可拾取特征`);
}

describe('成功率表 tuning.successRate（P2 初稿）', () => {
  it('五个判定位齐全且值域 (0,1]', () => {
    const s = emptySim(1);
    for (const [k, v] of Object.entries(s.tuning.successRate)) {
      expect(v, `successRate.${k} 应在 (0,1]`).toBeGreaterThan(0);
      expect(v, `successRate.${k} 应 ≤1`).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(s.tuning.successRate).sort()).toEqual([
      'attack', 'climb', 'dialogue', 'pickup', 'sprint',
    ]);
  });

  it('对话数据表：colony 默认 + elder 示例都存在，选项结构合法', () => {
    const s = emptySim(1);
    const colony = s.tuning.dialogues.colony;
    expect(colony).toBeDefined();
    expect(colony.lines.length).toBeGreaterThan(0);
    expect(colony.options.length).toBeGreaterThan(0);
    expect(s.tuning.dialogues.elder).toBeDefined();
  });
});

describe('interact 环境交互原语', () => {
  it('范围内无对象 → none（不设冷却，允许探测）', () => {
    const s = emptySim(5);
    const eid = s.spawnPawn(0, 0);
    expect(s.interact(eid)).toEqual({ kind: 'none' });
    expect(s.pawnMap.get(eid)!.interactCd ?? 0).toBe(0);
  });

  it('拾取成功：浆果→food / 树→wood 入库，过 pickup 成功率', () => {
    const s = emptySim(42);
    const spot = findPickupSpot(s);
    const eid = s.spawnPawn(spot.x, spot.y);
    const out = s.interact(eid);
    expect(out).not.toBeNull();
    if (out!.kind === 'pickup') {
      const key = spot.kind === 'berry' ? 'food' : 'wood';
      expect(out!.item).toBe(key);
      expect(s.stockpile[key] ?? 0).toBe(1);
    } else if (out!.kind === 'pickup-fail') {
      // pickup=0.9 仍有 10% 失败面：失败语义 = 本次不采到 + 冷却
      expect(s.stockpile.food ?? 0).toBe(0);
      expect(s.pawnMap.get(eid)!.interactCd ?? 0).toBeGreaterThan(0);
    } else {
      throw new Error(`预期 pickup 结果，得到 ${JSON.stringify(out)}`);
    }
  });

  it('拾取判定失败：stock 不变 + 进交互冷却（失败语义可回放）', () => {
    const reg = new ModRegistry();
    reg.overrideTuning((t) => {
      t.successRate.pickup = 0;
    });
    const s = new Sim({ seed: 42, registry: reg, pawnCount: 0 });
    const spot = findPickupSpot(s);
    const eid = s.spawnPawn(spot.x, spot.y);
    const out = s.interact(eid);
    expect(out).toEqual({ kind: 'pickup-fail' });
    expect(s.stockpile.food ?? 0).toBe(0);
    expect(s.stockpile.wood ?? 0).toBe(0);
    expect(s.pawnMap.get(eid)!.interactCd ?? 0).toBeGreaterThan(0);
  });

  it('冷却闸：拾取后立即再 interact → null', () => {
    const s = emptySim(42);
    const spot = findPickupSpot(s);
    const eid = s.spawnPawn(spot.x, spot.y);
    s.interact(eid);
    expect(s.interact(eid)).toBeNull(); // interactCd > 0
  });

  it('建筑使用：单座篝火 = use（fire），需求小幅恢复', () => {
    const reg = ModRegistry.mountPacks([buildingPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 0 });
    s.addBuilding('campfire', 0, 0);
    const eid = s.spawnPawn(1, 0); // 距火 1 格 ≤ interactRange
    const p = s.pawnMap.get(eid)!;
    const beforeMood = p.needs.mood;
    const out = s.interact(eid);
    expect(out).toEqual({ kind: 'use', tag: 'fire' });
    expect(p.needs.mood).toBe(Math.min(100, beforeMood + 3));
  });

  it('传送：两座篝火（waypoint 对）→ teleport 到另一座', () => {
    const reg = ModRegistry.mountPacks([buildingPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 0 });
    s.addBuilding('campfire', 0, 0);
    s.addBuilding('campfire', 10, 0);
    const eid = s.spawnPawn(1, 0);
    const out = s.interact(eid);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('teleport');
    if (out!.kind === 'teleport') {
      expect(out!.to).toEqual({ x: 10, y: 0 });
      expect(s.pawnMap.get(eid)!.pos).toEqual({ x: 10, y: 0 });
    }
  });
});

describe('NPC 对话状态机', () => {
  it('E 交互打开对话：dialogueId 缺省 = colony，sim.dialogue 置位', () => {
    const s = emptySim(9);
    const hero = s.spawnPawn(0, 0);
    const npc = s.spawnPawn(2, 0); // 距 hero 2 ≤ interactRange 2.5
    const out = s.interact(hero);
    expect(out).toEqual({ kind: 'npc', npcEid: npc });
    expect(s.dialogue).toEqual({ npcEid: npc, dialogueId: 'colony' });
  });

  it('玩家选「认识一下」：无判定，保持对话', () => {
    const s = emptySim(9);
    const hero = s.spawnPawn(0, 0);
    s.spawnPawn(2, 0);
    s.interact(hero);
    expect(s.chooseOption(0)).toBe('applied');
    expect(s.dialogue).not.toBeNull();
  });

  it('「讨点口粮」：dialogue 成功率 1.0 → food +5 并关对话（给玩家里子）', () => {
    const reg = new ModRegistry();
    reg.overrideTuning((t) => {
      t.successRate.dialogue = 1.0;
    });
    const s = new Sim({ seed: 9, registry: reg, pawnCount: 0 });
    const hero = s.spawnPawn(0, 0);
    s.spawnPawn(2, 0);
    s.interact(hero);
    expect(s.chooseOption(1)).toBe('closed');
    expect(s.stockpile.food ?? 0).toBe(5);
    expect(s.dialogue).toBeNull();
  });

  it('「讨点口粮」：dialogue 成功率 0 → NPC 拒绝，效果不生效（可回放）', () => {
    const reg = new ModRegistry();
    reg.overrideTuning((t) => {
      t.successRate.dialogue = 0;
    });
    const s = new Sim({ seed: 9, registry: reg, pawnCount: 0 });
    const hero = s.spawnPawn(0, 0);
    s.spawnPawn(2, 0);
    s.interact(hero);
    expect(s.chooseOption(1)).toBe('rejected');
    expect(s.stockpile.food ?? 0).toBe(0);
    expect(s.dialogue).toBeNull();
  });

  it('「再会」：关对话', () => {
    const s = emptySim(9);
    const hero = s.spawnPawn(0, 0);
    s.spawnPawn(2, 0);
    s.interact(hero);
    expect(s.chooseOption(2)).toBe('closed');
    expect(s.dialogue).toBeNull();
  });

  it('走远后选择选项 → 对话自动关闭（防隔空操作）', () => {
    const s = emptySim(9);
    const hero = s.spawnPawn(0, 0);
    const npc = s.spawnPawn(2, 0);
    s.interact(hero);
    // 把 NPC 移出 interactRange
    s.pawnMap.get(npc)!.pos = { x: 20, y: 0 };
    expect(s.chooseOption(0)).toBe('closed');
    expect(s.dialogue).toBeNull();
  });

  it('elder 对话：techFragment 选项走科技抽卡池（任务给"抽卡"面子）；id 未注册 → 静默跳过不抛错', () => {
    const s = emptySim(9);
    const hero = s.spawnPawn(0, 0);
    const npcEid = s.spawnPawn(2, 0);
    s.pawnMap.get(npcEid)!.npc = { dialogueId: 'elder' };
    s.interact(hero);
    expect(s.dialogue!.dialogueId).toBe('elder');
    // craft:tool 未注册（出厂 techs 空表）→ grantTechFragment 返回 'unknown'，选项仍生效（保持对话）
    expect(s.chooseOption(0)).toBe('applied');
    expect(s.dialogue).not.toBeNull();
  });
});
