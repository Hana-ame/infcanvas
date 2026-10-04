/**
 * contracts.test.ts —— 契约纪律（原则⑦）：系列词汇表登记校验。
 * （2026-08-21 用户裁定："××令"/策略卡机制移除，相关校验一并删除。）
 */
import { describe, expect, it } from 'vitest';
import { ModRegistry, type ModPack } from '../mods';
import { SER_GATHER } from '../mods/contracts';

const minimal: ModPack = {
  id: 'minimal',
  requires: [],
  apply(m) {
    m.registerCard({ id: 'work', label: '干活', series: SER_GATHER, weight: 1, action: () => {} });
  },
};

describe('跨包契约', () => {
  it('默认装配通过契约校验（挂载即校验，违例即抛）', () => {
    expect(() => ModRegistry.default()).not.toThrow();
  });

  it('卡引用未登记系列 → 挂载报错（拼写漂移在装配期暴露）', () => {
    const bad: ModPack = {
      id: 'bad',
      requires: [],
      apply(m) {
        m.registerCard({ id: 'typo', label: '手滑', series: 'gahter', weight: 1, action: () => {} }); // 拼错
      },
    };
    expect(() => ModRegistry.mountPacks([minimal, bad])).toThrow(/未登记系列/);
  });

  it('卸载写方后引用消失 = 校验自然通过（空真不误伤卸载纪律）', () => {
    expect(() => ModRegistry.mountPacks([minimal])).not.toThrow();
  });
});
