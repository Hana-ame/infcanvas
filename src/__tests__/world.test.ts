/**
 * world.test.ts —— 无限地图确定性 + 特征收割/再生 + 建筑占位。
 */
import { describe, expect, it } from 'vitest';
import { World } from '../sim/world';
import { DEFAULT_TUNING } from '../sim/tuning';

function mkWorld(): World {
  const w = new World(structuredClone(DEFAULT_TUNING), 42, { x: 0, y: 0 });
  // 建筑定义是玩法包种子（默认表为空）；世界层测试注入最小定义即可
  w.tuning.buildings['campfire'] = { name: '篝火', cost: {}, hp: 80, tags: ['fire'], passable: true };
  // 与 building 包真实定义同形（含 2×2 占地）——占地字段缺失会让多格断言失真
  w.tuning.buildings['hut'] = { name: '棚屋', cost: {}, hp: 200, tags: ['shelter'], passable: false, w: 2, h: 2 };
  return w;
}

describe('无限世界', () => {
  it('确定性：tileAt/featureAt 与时间、调用次序无关', () => {
    const w = mkWorld();
    w.now = 12345;
    const t1 = [w.tileAt(17, -31), w.tileAt(-100, 250), w.featureAt(9, 9)];
    const w2 = mkWorld();
    const t2 = [w2.tileAt(17, -31), w2.tileAt(-100, 250), w2.featureAt(9, 9)];
    expect(t1).toEqual(t2);
  });

  it('出生安全区：半径内全可通行且无特征（开局不被地形卡死）', () => {
    const w = mkWorld();
    const r = w.tuning.world.spawnClearRadius;
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        expect(w.passable(x, y)).toBe(true);
        expect(w.featureAt(x, y)).toBeNull();
      }
    }
  });

  it('水不可通行；负坐标与远坐标同样有效（真·无限）', () => {
    const w = mkWorld();
    let sawWater = false;
    for (let x = -200; x <= 200 && !sawWater; x += 7) {
      for (let y = -200; y <= 200; y += 7) {
        if (Math.abs(x) <= 6 && Math.abs(y) <= 6) continue;
        if (w.tileAt(x, y) === 'water') {
          expect(w.passable(x, y)).toBe(false);
          sawWater = true;
          break;
        }
      }
    }
    // 大坐标不炸（防御边界内）
    expect(() => w.tileAt(5000, -5000)).not.toThrow();
  });

  it('特征收割：takeOne 扣余量 → 0 时进再生冷却，冷却内查不到、到期恢复', () => {
    const w = mkWorld();
    w.now = 0;
    // 找一个真实浆果丛
    let bush: { x: number; y: number } | null = null;
    outer: for (let r = 7; r < 40; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const f = w.featureAt(dx, dy);
          if (f?.kind === 'berry') {
            bush = { x: dx, y: dy };
            break outer;
          }
        }
      }
    }
    expect(bush).not.toBeNull();
    const full = w.featureAt(bush!.x, bush!.y)!.amount;
    let left = full;
    while (left > 0) {
      left = w.takeOne(bush!.x, bush!.y);
    }
    expect(left).toBe(0);
    expect(w.featureAt(bush!.x, bush!.y)).toBeNull(); // 冷却中
    w.now = w.tuning.world.harvestRegenSec + 1;
    expect(w.featureAt(bush!.x, bush!.y)?.amount).toBe(full); // 再生=满额
  });

  it('建筑多格占地：棚屋 2×2 整块占格、拆除全恢复、间距按矩形外扩判定', () => {
    const w = mkWorld();
    // 动态找一块 2×2 全可通行区域（圈外有水/岩/树）
    function fitsHut(x: number, y: number): boolean {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (!w.passable(x + dx, y + dy)) return false; // passable 含树冠阻挡
        }
      }
      return true;
    }
    let spotA: { x: number; y: number } | null = null; // 篝火点（1×1）
    let spotB: { x: number; y: number } | null = null; // 棚屋点（2×2，远离 A）
    outer: for (let y = -60; y <= 60; y++) {
      for (let x = -60; x <= 60; x++) {
        if (!fitsHut(x, y)) continue;
        if (!spotA) {
          spotA = { x, y };
          continue;
        }
        if (Math.abs(x - spotA.x) > 8 || Math.abs(y - spotA.y) > 8) {
          spotB = { x, y };
          break outer;
        }
      }
    }
    expect(spotA && spotB).toBeTruthy();

    // 棚屋 2×2：四格全部变阻挡；拆除后全部恢复
    const b = w.addBuilding('hut', spotB!.x, spotB!.y)!;
    expect(b).toBeDefined();
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) expect(w.passable(spotB!.x + dx, spotB!.y + dy)).toBe(false);
    }
    w.removeBuilding(b.id);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) expect(w.passable(spotB!.x + dx, spotB!.y + dy)).toBe(true);
    }
    // 篝火 1×1 不阻挡
    const f1 = w.addBuilding('campfire', spotA!.x, spotA!.y)!;
    expect(f1).toBeTruthy();
    expect(w.passable(spotA!.x, spotA!.y)).toBe(true);
    // 同类间距：贴邻被拒（矩形外扩判定），远格可放
    expect(w.addBuilding('campfire', spotA!.x + 1, spotA!.y)).toBeNull();
    expect(w.addBuilding('campfire', spotB!.x, spotB!.y)).toBeTruthy();
  });

  it('大树 2×2：锚点即特征、整块阻挡通行、产量放大', () => {
    const w = mkWorld();
    // 找一棵真实大树（锚点格）
    let tree: { x: number; y: number } | null = null;
    outer: for (let r = 7; r < 50; r += 1) {
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const f = w.featureAt(x, y);
          if (f?.kind === 'tree') {
            tree = { x, y };
            break outer;
          }
        }
      }
    }
    expect(tree).not.toBeNull();
    const rect = w.featureRect({ kind: 'tree', ...tree! });
    expect(rect.x1 - rect.x0).toBe(1); // 2×2
    // 锚点哈希决定满额产量：4~6 木（大树比旧单格 2~3 多）
    const full = w.featureAt(tree!.x, tree!.y)!.amount;
    expect(full).toBeGreaterThanOrEqual(4);
    // 整块阻挡：canopy 覆盖的每个格都不可通行（除非恰有建筑——测试区无建筑）
    for (let y = rect.y0; y <= rect.y1; y++) {
      for (let x = rect.x0; x <= rect.x1; x++) {
        if (!w.buildingAt(x, y)) expect(w.passable(x, y)).toBe(false);
      }
    }
    // 非锚点的覆盖格不重复报特征（nearestFeature 以锚点为唯一代表）
    expect(w.featureAt(rect.x1, rect.y1)).toBeNull();
  });
});
