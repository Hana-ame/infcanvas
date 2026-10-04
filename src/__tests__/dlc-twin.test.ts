/**
 * dlc-twin.test.ts —— R2-3 验收：同一内容、两种部署形态。
 *
 * 主张（ROADMAP R2-3）：mods/sample-berry.mod.json（纯 JSON，放文件即装）
 * 与 src/mods/packs/sample-berry.ts（TS 包，DLC 式）表达同一份内容，
 * 装配后的注册面应当**等价**——区别只在作者用什么写，不在引擎怎么装。
 *
 * 同时守住 R2-3 的另一条验收：挂载/卸载该 DLC 不影响默认装配。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { DEFAULT_PLAYSTYLE_PACKS } from '../mods/packs/playstyle';
import { sampleBerryPack } from '../mods/packs/sample-berry';
import { mountWithBase, parseModPackage, type LoadedMod } from '../server/mod-loader';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSON_MOD_PATH = join(HERE, '../../mods/sample-berry.mod.json');

/** 读仓库里真实的示例 JSON 包（测的是"放文件即装"这条真实链路，不是内联字面量） */
function jsonMod(): LoadedMod {
  return {
    file: JSON_MOD_PATH,
    pkg: parseModPackage(readFileSync(JSON_MOD_PATH, 'utf-8'), 'sample-berry.mod.json'),
  };
}

/** 取装配后各注册面的可比快照（只取两边都该有的内容面） */
function snapshot(reg: ModRegistry) {
  const t = reg.effectiveTuning();
  return {
    items: reg.items.map((i) => `${i.id}=${i.name}`).sort(),
    buildings: Object.keys(t.buildings).sort(),
    enemies: Object.keys(t.enemies).sort(),
    techs: Object.keys(t.techs).sort(),
    cards: reg.cards.map((c) => c.id).sort(),
  };
}

describe('R2-3 DLC 式独立包示范', () => {
  it('同一内容两种部署形态：JSON 版与 TS 版装配结果等价', () => {
    const viaJson = mountWithBase([], [jsonMod()]).registry;
    const viaTs = ModRegistry.mountPacks([sampleBerryPack]);
    expect(snapshot(viaTs)).toEqual(snapshot(viaJson));
  });

  it('两版都能与默认玩法共存并跑起来（不是替代默认装配）', () => {
    const jsonReg = mountWithBase(DEFAULT_PLAYSTYLE_PACKS, [jsonMod()]).registry;
    const tsReg = ModRegistry.mountPacks([...DEFAULT_PLAYSTYLE_PACKS, sampleBerryPack]);
    for (const [name, reg] of [['JSON', jsonReg], ['TS', tsReg]] as const) {
      const sim = new Sim({ seed: 42, registry: reg });
      expect(() => sim.run(120), name).not.toThrow();
      // 默认内容（野猫/篝火）与 DLC 内容（刺蜂/蓝莓丛）同时在场
      expect(sim.tuning.enemies['cat'], name).toBeDefined();
      expect(sim.tuning.enemies['hornet'], name).toBeDefined();
      expect(sim.tuning.buildings['blueberryBush'], name).toBeDefined();
      expect(sim.tuning.buildings['campfire'], name).toBeDefined();
    }
  });

  it('TS 版多出来的能力：谓词真的生效（JSON 版 v1 表达不了函数字段）', () => {
    const reg = ModRegistry.mountPacks([...DEFAULT_PLAYSTYLE_PACKS, sampleBerryPack]);
    const sim = new Sim({ seed: 7, registry: reg });
    const card = reg.cardById('sample_pick_berry')!;
    expect(card.condition).toBeDefined();
    // 食物充足 → 谓词假（TS 版的真正价值：卡会按局面自动进出候选池）
    sim.stockpile['food'] = 999;
    const p = [...sim.pawns()][0];
    expect(card.condition!(p, sim)).toBe(false);
    sim.stockpile['food'] = 0;
    expect(card.condition!(p, sim)).toBe(true);
  });

  it('挂载/卸载 DLC 不影响默认装配（默认清单不含该 DLC）', () => {
    // 默认清单里没有 sample-berry（DLC 不是默认内容）
    expect(DEFAULT_PLAYSTYLE_PACKS.some((p) => p.id === 'sample-berry')).toBe(false);
    const base = ModRegistry.mountPacks(DEFAULT_PLAYSTYLE_PACKS);
    const withDlc = ModRegistry.mountPacks([...DEFAULT_PLAYSTYLE_PACKS, sampleBerryPack]);
    // 差异只有 DLC 自己新增的那些，其余完全一致
    expect(withDlc.cards.length - base.cards.length).toBe(1);
    expect(Object.keys(withDlc.effectiveTuning().enemies).length).toBe(
      Object.keys(base.effectiveTuning().enemies).length + 1,
    );
    // 卸载（不挂）后默认装配照常可跑
    expect(() => new Sim({ seed: 3, registry: base }).run(60)).not.toThrow();
  });
});
