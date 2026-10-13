/**
 * direct-control.test.ts —— P1 主角直接操控单测（2026-10-13）。
 *
 * 设计口径（KB proj-infcanvas-direct-control-proposal-2026-10-13，终版）：
 * 以人操纵为主 + 成功率判定，可跳过抽卡。本文件只测**新引入的原语**：
 *   - 输入层纯函数（moveVector/joystickVector/KeyboardInput）——客户端合成方向意图；
 *   - sim.moveDir —— 方向意图 → 分轴位移 + 格心碰撞（复用 canStep/canStand）；
 *   - sim.rollSuccess —— 成功率判定原语（复用权威 rng 单流，确定性续跑）；
 *   - sim.directAttack —— 成功率判定的动作示例（命中/落空/冷却/无目标不消费 rng）。
 *
 * 与自主局零交集：上述原语都不进 behavior 抽卡路径、不占 cardId/busyUntil，
 * golden 确定性指纹不受影响（既有 golden.test.ts 断言自动守护）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { raidPack } from '../mods/packs/raid';
import { moveVector, joystickVector, KeyboardInput } from '../client/input';

/** 空装配内核 Sim（无玩法包、无出生鼠）——只测内核原语，不让自主 AI 干扰。 */
function emptySim(seed = 42): Sim {
  return new Sim({ seed, registry: new ModRegistry(), pawnCount: 0 });
}

/** 找一对「水格 + 左侧相邻可立足格」：moveDir 阻挡测试的固定地形锚点。
 *  spawn 安全区半径 6 内无水/石/树，故从 30×30 环带里找。 */
function findWaterNeighbor(s: Sim): { wx: number; wy: number; landX: number; landY: number } {
  for (let y = -30; y <= 30; y++) {
    for (let x = -30; x <= 30; x++) {
      if (s.world.tileAt(x, y) === 'water' && s.world.canStand(x - 1, y)) {
        return { wx: x, wy: y, landX: x - 1, landY: y };
      }
    }
  }
  throw new Error(`测试数据：seed=${s.world.seed} 下 60×60 找不到「水+相邻陆地」对`);
}

describe('input 向量合成（纯函数）', () => {
  it('单方向键 = 单位向量', () => {
    expect(moveVector(['KeyW'])).toEqual({ x: 0, y: -1 });
    expect(moveVector(['KeyD'])).toEqual({ x: 1, y: 0 });
    expect(moveVector(['ArrowUp'])).toEqual({ x: 0, y: -1 });
  });

  it('对角 = 1/√2 归一化（WASD 与方向键双套同向合并，不翻倍）', () => {
    const v = moveVector(['KeyW', 'KeyA', 'ArrowUp', 'ArrowLeft']);
    expect(v.x).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(v.y).toBeCloseTo(-Math.SQRT1_2, 10);
  });

  it('无按键 = 静止；对立键 = 抵消', () => {
    expect(moveVector([])).toEqual({ x: 0, y: 0 });
    expect(moveVector(['KeyW', 'KeyS'])).toEqual({ x: 0, y: 0 });
  });

  it('摇杆死区：小位移归零；超死区归一化（方向优先）', () => {
    expect(joystickVector(0.1, 0, 0.15)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(0, 0, 0.15)).toEqual({ x: 0, y: 0 });
    const v = joystickVector(0.5, 0.5, 0.15);
    expect(v.x).toBeCloseTo(Math.SQRT1_2, 10);
    expect(v.y).toBeCloseTo(Math.SQRT1_2, 10);
  });
});

describe('KeyboardInput 状态机（纯逻辑）', () => {
  it('down/up 驱动向量；对立键同按抵消', () => {
    const k = new KeyboardInput();
    k.down('KeyW');
    expect(k.vector()).toEqual({ x: 0, y: -1 });
    k.down('KeyS');
    expect(k.vector()).toEqual({ x: 0, y: 0 });
    k.up('KeyW');
    expect(k.vector()).toEqual({ x: 0, y: 1 });
    k.up('KeyS');
    expect(k.vector()).toEqual({ x: 0, y: 0 });
  });
});

describe('moveDir 直接移动（以人操纵为主，无成功率）', () => {
  it('轴向自由移动 = hero.speed × dt（dt 钳制 0.25 内）', () => {
    const s = emptySim(7);
    const eid = s.spawnPawn(0, 0);
    const p = s.pawnMap.get(eid)!;
    const moved = s.moveDir(p, 1, 0, 0.1);
    expect(moved).toBe(true);
    expect(p.pos.x).toBeCloseTo(s.tuning.hero.speed * 0.1, 9);
    expect(p.pos.y).toBe(0);
  });

  it('对角位移两轴同比例推进', () => {
    const s = emptySim(7);
    const eid = s.spawnPawn(0, 0);
    const p = s.pawnMap.get(eid)!;
    s.moveDir(p, Math.SQRT1_2, Math.SQRT1_2, 0.1);
    const d = s.tuning.hero.speed * 0.1 * Math.SQRT1_2;
    expect(p.pos.x).toBeCloseTo(d, 9);
    expect(p.pos.y).toBeCloseTo(d, 9);
  });

  it('被水阻挡：贴当前格边界钳制，不进水域，持续推返回 false', () => {
    const s = emptySim(42);
    const { landX, landY, wx } = findWaterNeighbor(s);
    const eid = s.spawnPawn(landX, landY);
    const p = s.pawnMap.get(eid)!;
    for (let i = 0; i < 40; i++) s.moveDir(p, 1, 0, 0.1); // 意图 18 格，应被水挡住
    expect(p.pos.x).toBeCloseTo(wx - 0.5 - 0.01, 6); // 贴水格边界（0.01 裕量防抖动）
    expect(s.world.canStand(p.pos.x, p.pos.y)).toBe(true); // 站位仍在陆格
    let last = true;
    for (let i = 0; i < 5 && last; i++) last = s.moveDir(p, 1, 0, 0.1);
    expect(last).toBe(false); // 已贴死，不再产生位移
  });

  it('分轴独立：x 被挡时 y 轴移动不拖 x（贴墙滑动机制）', () => {
    const s = emptySim(42);
    const { landX, landY, wx } = findWaterNeighbor(s);
    const eid = s.spawnPawn(landX, landY);
    const p = s.pawnMap.get(eid)!;
    for (let i = 0; i < 40; i++) s.moveDir(p, 1, 0, 0.1); // 先把 x 推到水边钳制
    expect(p.pos.x).toBeCloseTo(wx - 0.5 - 0.01, 6);
    s.moveDir(p, 0, 1, 0.1); // 纯 y 意图
    expect(p.pos.x).toBeCloseTo(wx - 0.5 - 0.01, 6); // x 不被 y 轴拖动
  });

  it('moveDir 不消费 rng（直接移动不进确定性随机序列）', () => {
    const s = emptySim(7);
    const eid = s.spawnPawn(0, 0);
    const p = s.pawnMap.get(eid)!;
    const st = s.rngState();
    s.moveDir(p, 1, 0, 0.1);
    expect(s.rngState()).toBe(st);
  });
});

describe('rollSuccess 成功率判定原语', () => {
  it('rate=1 恒真、rate=0 恒假', () => {
    const s = emptySim(42);
    expect(s.rollSuccess(1)).toBe(true);
    expect(s.rollSuccess(0)).toBe(false);
  });

  it('确定性：同 seed 同调用序列 → 同结果序列（rng 单流随档可回放）', () => {
    const a = emptySim(7);
    const b = emptySim(7);
    const seqA: boolean[] = [];
    const seqB: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      seqA.push(a.rollSuccess(0.5));
      seqB.push(b.rollSuccess(0.5));
    }
    expect(seqA).toEqual(seqB);
  });

  it('每次判定消费 rng（rng 状态前进 → 存档续跑可复现）', () => {
    const s = emptySim(7);
    const st = s.rngState();
    s.rollSuccess(0.5);
    expect(s.rngState()).not.toBe(st);
  });
});

describe('directAttack 主角攻击示例（成功率判定落地，失败语义可回放）', () => {
  function fightSim(seed = 3, hitChance?: number): Sim {
    const reg = ModRegistry.mountPacks([raidPack]); // 只挂 raid 拿 'cat' 敌人表
    if (hitChance !== undefined) {
      reg.overrideTuning((t) => {
        t.successRate.attack = hitChance; // P2：命中率收编进成功率表
      });
    }
    return new Sim({ seed, registry: reg, pawnCount: 0 });
  }

  it('命中：伤害 = pawn.dmg、进入冷却、日志记录', () => {
    const s = fightSim(3, 1.0);
    const eid = s.spawnPawn(0, 0);
    const cat = s.spawnHostile('cat', 1, 0); // 距离 1 ≤ attackRange 1.75
    const before = cat.hp;
    expect(s.directAttack(eid)).toBe(true);
    expect(s.pawnMap.get(eid)!.atkCd).toBeGreaterThan(0);
    const after = s.hostiles().find((h) => h.id === cat.id)!;
    expect(after.hp).toBe(before - s.tuning.pawn.dmg);
    expect(s.events.some((e) => e.text.includes('命中'))).toBe(true);
  });

  it('落空：无伤害但同样进冷却（失败语义 = 不生效但进冷却）', () => {
    const s = fightSim(3, 0.0);
    const eid = s.spawnPawn(0, 0);
    const cat = s.spawnHostile('cat', 1, 0);
    const before = cat.hp;
    expect(s.directAttack(eid)).toBe(true);
    expect(s.pawnMap.get(eid)!.atkCd).toBeGreaterThan(0);
    expect(s.hostiles().find((h) => h.id === cat.id)!.hp).toBe(before);
    expect(s.events.some((e) => e.text.includes('落空'))).toBe(true);
  });

  it('冷却中：不动手且不消费 rng', () => {
    const s = fightSim(3, 1.0);
    const eid = s.spawnPawn(0, 0);
    s.spawnHostile('cat', 1, 0);
    s.directAttack(eid); // 命中 → 冷却
    const st = s.rngState();
    expect(s.directAttack(eid)).toBe(false); // atkCd > 0
    expect(s.rngState()).toBe(st); // 冷却早退，未碰 rng
  });

  it('无目标：return false 且不消费 rng', () => {
    const s = fightSim(3, 1.0);
    const eid = s.spawnPawn(0, 0);
    const st = s.rngState();
    expect(s.directAttack(eid)).toBe(false);
    expect(s.rngState()).toBe(st);
  });

  it('击杀：打死即 despawn（与 raid 伤害出口同语义）', () => {
    const s = fightSim(3, 1.0);
    const eid = s.spawnPawn(0, 0);
    s.spawnHostile('cat', 1, 0); // hp 24，pawn.dmg 6 → 4 次命中
    const p = s.pawnMap.get(eid)!;
    for (let i = 0; i < 4; i++) {
      p.atkCd = 0; // 清冷却模拟时间流逝
      expect(s.directAttack(eid)).toBe(true);
    }
    expect(s.hostiles().length).toBe(0);
  });
});
