/**
 * client-view.test.ts —— 视图层纯逻辑单测：inspect 属性卡语义（本地/远程同构，
 * 这里以 LocalView 为准锁行为；零 DOM/零 Pixi 依赖，node 环境可跑）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { LocalView } from '../client/local-view';

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
