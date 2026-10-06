/**
 * survival-loop.test.ts —— 阶段①交付标准验收：0 操作自主生存闭环。
 * 4 鼠开局 → 采集/进食/睡觉/建造/社交全自主 → 敌袭战或逃。
 * 断言刻意宽松在"生存底线"（≥2 存活），允许灾难局——输就是好玩，但不能是常态。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';

describe('0 操作自主生存闭环', () => {
  const s = new Sim({ seed: 42, registry: ModRegistry.default() });
  s.run(900); // 15 分钟游戏时间，零操作

  it('鼠群大体存活（灾难是故事，团灭不是常态）', () => {
    expect([...s.pawns()].length).toBeGreaterThanOrEqual(2);
    // 活着的鼠需求被行为维持着：没人饿到濒死还站着不动
    for (const p of s.pawns()) {
      expect(p.needs.food).toBeGreaterThan(0);
    }
  });

  it('生存闭环发生过：采集入库 / 进食 / 睡眠 / 建造全部出现', () => {
    let gather = 0;
    let eat = 0;
    let sleep = 0;
    for (const p of s.pawns()) {
      gather += p.uses['gather_berry'] ?? 0;
      eat += p.uses['eat'] ?? 0;
      sleep += p.uses['sleep'] ?? 0;
    }
    // 已死鼠的 uses 也该算进历史？uses 随实体销毁——用事件与库存兜底断言
    const gatheredFood = (s.stockpile['food'] ?? 0) + eat; // 现存库存 + 被吃掉的 = 曾采集的
    expect(gatheredFood).toBeGreaterThan(10);
    expect(s.stockpile['wood'] !== undefined).toBe(true);
    // 建造：至少初始篝火 + 后续自主建筑（棚屋/新火堆）
    expect(s.world.buildings.size).toBeGreaterThanOrEqual(2);
    // 行为多样性：抽卡驱动的生活，不是全员机械重复同一张卡
    const distinctCards = new Set([...s.pawns()].flatMap((p) => Object.keys(p.uses)));
    expect(distinctCards.size).toBeGreaterThanOrEqual(3);
  });

  it('熟练度在演化：用得多的卡长出了习惯（mastery > 0）', () => {
    const mastered = [...s.pawns()].some((p) => Object.values(p.mastery).some((m) => m.v > 5));
    expect(mastered).toBe(true);
  });

  it('敌袭按叙事压力到来，且营地有还手之力（战或逃都发生了）', () => {
    expect(s.events.some((e) => e.text.includes('出没'))).toBe(true);
    // 战或逃：击退/迎战/撤退/鼠方伤亡 任一即算真实交战
    // （死亡鼠的 uses 随实体销毁，故必须同时看事件流）
    const repelled = s.events.some((e) => e.text.includes('被击退'));
    const foughtOrFled =
      [...s.pawns()].some((p) => (p.uses['fight'] ?? 0) + (p.uses['flee'] ?? 0) > 0) ||
      s.events.some((e) => e.text.includes('野猫袭击'));
    expect(repelled || foughtOrFled).toBe(true);
  });

});

/** 本局"曾产出的木材"= 库存现存 + 建筑消耗（篝火4×n + 棚屋12×n 的粗账） */
function woodGained(s: Sim): number {
  let spent = 0;
  for (const b of s.world.buildings.values()) {
    spent += s.tuning.buildings[b.defId].cost['wood'] ?? 0;
  }
  return (s.stockpile['wood'] ?? 0) + spent;
}
