// cooking 玩法包独立测试（2026-08-14：篝火烹饪）
// 覆盖：① 篝火自动烤食（4 food + 1 wood → 5 food，间隔 4s）；② 缺食材不动锅；
// ③ 无篝火无事发生；④ campfire def 带 cook 配方（数据驱动接线生效）。
// 设计背景（用户 2026-08-14「火堆要能 cook」）：CookSystem 独立于 craft 系统——
// hg（采集狩猎）卸载 craft 后篝火仍能烤肉（游牧烤肉是世界观刚需）。
// 本测试只注入 CookSystem，天然证明其不依赖 craft 存在。
import { describe, it, expect } from 'vitest';
import { makeMinCtx } from '../../sim/__tests__/helpers/minCtx';
import { attach } from '../../sim/__tests__/helpers/minCtx';
import { CookSystem } from '../packs/cooking';

const campfire = (ctx: ReturnType<typeof makeMinCtx>) => {
  const cx = Math.floor(ctx.world.width / 2), cy = Math.floor(ctx.world.height / 2);
  for (let r = 0; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) return { x, y };
      }
    }
  }
  throw new Error('找不到可建篝火的位置');
};

describe('cooking 玩法包（篝火烹饪）', () => {
  it('campfire def 已接线 cook 配方（数据驱动生效）', () => {
    const ctx = makeMinCtx(1);
    const def = ctx.buildingDef('campfire')!;
    expect(def.recipe).toBe('cook');
    // cook 判定只看 def.recipe（2026-08-15 审计：不再重列 tags——tags 保持内核原值，
    // 不含 'cook'；断言此行为防回归"重复维护点"）
    expect(def.tags).not.toContain('cook');
    expect(def.tags).toContain('anchor');
    const r = ctx.recipe('cook')!;
    expect(r.kind).toBe('batch');
    expect(r.input).toEqual([{ item: 'food', amount: 4 }, { item: 'wood', amount: 1 }]);
    expect(r.output).toEqual({ item: 'food', amount: 5 });
  });

  it('overrideDef 深合并：campfire meta 同时含 thermo 的 heat 与 cooking 的 cookSpiced', () => {
    // 发现背景（2026-08-14）：overrideDef 原为浅合并，嵌套 meta 整体替换——thermo 补
    // meta.heat 后 cooking 再补 meta.cookSpiced 会把 heat 冲掉（反之亦然），两个包互斥。
    // 改为深合并后嵌套字段按 key 共存。此用例守护该契约（两个包都默认挂载）。
    const ctx = makeMinCtx(1);
    const meta = ctx.buildingDef('campfire')!.meta ?? {};
    expect(meta['heat']).toBeDefined();       // thermo 包
    expect(meta['cookSpiced']).toBe('cook_spiced'); // cooking 包
  });

  it('加料烹饪：有香料走 cook_spiced（4 food + 1 wood + 1 spice → 7 food），无香料回落基础', () => {
    const ctx = makeMinCtx(2);
    campfire(ctx);
    ctx.stockpile.food = 4;
    ctx.stockpile.wood = 2;  // 两轮的量
    ctx.stockpile.spice = 1;
    const sys = attach(ctx, new CookSystem(ctx));
    sys.update(0.5);  // 首轮就绪：有香料 → 加料
    expect(ctx.stockpile.food).toBe(7);
    expect(ctx.stockpile.spice).toBe(0);
    expect(ctx._log.some((l) => l.includes('🧂'))).toBe(true);
    sys.update(4.5);  // 第二轮：香料耗尽 → 回落基础 4+1→5
    expect(ctx.stockpile.food).toBe(8); // 7-4+5
    expect(ctx.stockpile.wood).toBe(0);
    expect(ctx._log.some((l) => l.includes('🍳'))).toBe(true);
  });

  it('有香料但粮食不足：不加料也不动锅（不烧仅有的口粮）', () => {
    const ctx = makeMinCtx(3);
    campfire(ctx);
    ctx.stockpile.food = 3; // 差 1
    ctx.stockpile.wood = 1;
    ctx.stockpile.spice = 5;
    const sys = attach(ctx, new CookSystem(ctx));
    sys.update(5);
    expect(ctx.stockpile.food).toBe(3);
    expect(ctx.stockpile.spice).toBe(5);
    expect(ctx._log.filter((l) => l.includes('🍳') || l.includes('🧂'))).toHaveLength(0);
  });

  it('篝火自动烤食：4 food + 1 wood → 5 food（首轮就绪，随后按 4s 间隔）', () => {
    const ctx = makeMinCtx(2);
    campfire(ctx);
    ctx.stockpile.food = 4;
    ctx.stockpile.wood = 1;
    const sys = attach(ctx, new CookSystem(ctx));
    sys.update(0.5);  // cd 初始 0 = 就绪：立即烤第一轮
    expect(ctx.stockpile.food).toBe(5);
    expect(ctx.stockpile.wood).toBe(0);
    expect(ctx._log.some((l) => l.includes('🍳'))).toBe(true);
    sys.update(1);    // cd=3 未到间隔：不动锅
    expect(ctx.stockpile.food).toBe(5);
    sys.update(3.5);  // 跨过间隔但 wood 已耗尽 → 缺食材不动锅（不欠账）
    expect(ctx.stockpile.food).toBe(5);
  });

  it('缺食材不烹饪（粮不够不动锅，口粮不会更少）', () => {
    const ctx = makeMinCtx(3);
    campfire(ctx);
    ctx.stockpile.food = 3; // 差 1
    ctx.stockpile.wood = 1;
    const sys = attach(ctx, new CookSystem(ctx));
    sys.update(5);
    expect(ctx.stockpile.food).toBe(3);
    expect(ctx._log.filter((l) => l.includes('🍳'))).toHaveLength(0);
  });

  it('无篝火：无事发生不报错', () => {
    const ctx = makeMinCtx(4);
    ctx.stockpile.food = 99;
    const sys = attach(ctx, new CookSystem(ctx));
    sys.update(10);
    expect(ctx.stockpile.food).toBe(99);
    expect(ctx._log.filter((l) => l.includes('🍳'))).toHaveLength(0);
  });
});