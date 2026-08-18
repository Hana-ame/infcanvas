// bootstrap 引导系统测试（2026-08-16 审计 L4）：
// 出生篝火此前"手动 onCampfireBuilt + building_built 事件监听"双触发（assignPawn 全量
// 重算跑两遍；fireMemory 有守卫掩盖）。修复 = 只发事件、统一走监听单入口。
import { describe, it, expect, beforeEach } from 'vitest';
import { makeMinCtx } from '../../sim/__tests__/helpers/minCtx';
import { BootstrapSystem } from '../packs/bootstrap';
import type { MinCtx } from '../../sim/__tests__/helpers/minCtx';

describe('bootstrap 出生篝火单触发（审计 L4，2026-08-16）', () => {
  let ctx: MinCtx;
  let calls: number;

  beforeEach(() => {
    ctx = makeMinCtx(31);
    // 计数 socialUnits.onCampfireBuilt（双触发 = 2；修复后 = 1）
    calls = 0;
    ctx.socialUnits = {
      ...ctx.socialUnits,
      onCampfireBuilt: () => { calls++; },
    } as MinCtx['socialUnits'];
  });

  it('出生篝火：onCampfireBuilt 只触发一次（事件单入口）', () => {
    const sys = new BootstrapSystem(ctx);
    sys.init(ctx.bus);
    expect(calls).toBe(1); // 此前：手动调用 + bus 监听又调 = 2
    // 篝火确实在出生点建出（事件真发出、placeBuilding 成功）
    const cx = Math.floor(ctx.world.width / 2);
    const cy = Math.floor(ctx.world.height / 2);
    expect(ctx.world.getBuilding(cx, cy + 2)?.def.id).toBe('campfire');
  });

  it('追加建篝火（building_built 事件）也走同一入口：每栋一次', () => {
    const sys = new BootstrapSystem(ctx);
    sys.init(ctx.bus);
    // 再建一栋（经系统事件面）：监听按 defId 匹配 starter → onCampfireBuilt 再 +1
    const cx = Math.floor(ctx.world.width / 2);
    for (let dx = -4; dx <= 4; dx++) {
      if (ctx.world.placeBuilding(cx + dx, 0, 'campfire', 'player')) {
        ctx.bus.emit({ type: 'building_built', x: cx + dx, y: 0, defId: 'campfire' });
        break;
      }
    }
    expect(calls).toBe(2); // 出生 1 + 追加 1（每栋 fire 一次，无重复）
  });
});