// socialUnitSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：建篝火初始化记忆 / 归属计算（最近 campfire）/ 建筑被毁写入记忆 / 遭袭达标另起篝火
import { describe, it, expect, beforeEach } from 'vitest';
import { SocialUnitSystem } from '../../systems/socialUnitSystem';
import { makeMinCtx } from '../helpers/minCtx';
import { World } from '../../core/world';

describe('SocialUnitSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(14);
  beforeEach(() => { ctx = makeMinCtx(14); });

  function placeCampfire(x: number, y: number): number {
    // 从 (x,y) 起找最近可建位置（地图随机，直接给坐标可能落在水上/不可建）
    for (let r = 0; r < 30; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= ctx.world.width || ny >= ctx.world.height) continue;
          if (ctx.world.placeBuilding(nx, ny, 'campfire', 'player')) return ctx.world.buildKey(nx, ny);
        }
      }
    }
    throw new Error('找不到可建 campfire 的位置');
  }

  it('建篝火 → 初始化营地记忆 + 全员归属', () => {
    const sys = new SocialUnitSystem(ctx);
    const eid = ctx.spawnPawn(30, 30);
    const key = placeCampfire(30, 30);
    sys.onCampfireBuilt(key);
    expect(ctx.world.fireMemory.get(key)![0].text).toContain('营地');
    expect(ctx._pawnStates.get(eid)!.fireId).toBe(key);
  });

  it('归属：走到最近篝火旁 → fireId 指向它（重算收敛）', () => {
    const sys = new SocialUnitSystem(ctx);
    const key = placeCampfire(40, 40);
    const eid = ctx.spawnPawn(41, 40);
    const st = ctx._pawnStates.get(eid)!;
    st.fireId = null; // 游牧
    // 触发周期重算
    const t = ctx.tuning.faction;
    for (let i = 0; i < Math.ceil(t.reassignInterval) + 2; i++) sys.update(1);
    expect(st.fireId).toBe(key);
  });

  it('建筑被毁 → 记入篝火记忆（💥 信号）', () => {
    const sys = new SocialUnitSystem(ctx);
    sys.init(ctx.bus);
    const key = placeCampfire(50, 50);
    // 新 key 编码（2026-08-14 无限地图）：必须 World.keyToXY 解码（负坐标支持）
    const { x: fx, y: fy } = World.keyToXY(key);
    const eid = ctx.spawnPawn(fx + 1, fy);
    sys.onCampfireBuilt(key);
    // 毁掉 campfire 旁一栋建筑（bus 事件 → 记忆）。
    // 注意顺序：先 emit 再 damage（事件里要按位置找"最近的 campfire"，建筑被删后就找不到了）
    ctx.bus.emit({ type: 'building_destroyed', x: fx, y: fy, defId: 'campfire' } as never);
    ctx.world.damageBuilding(fx, fy, 99999);
    const mem = ctx.world.fireMemory.get(key) ?? [];
    expect(mem.some((m) => m.text.includes('💥'))).toBe(true);
  });

  it('遭袭计数达标（≥3 次 💥）+ 威胁在场 → 另起篝火', () => {
    const sys = new SocialUnitSystem(ctx);
    sys.init(ctx.bus);
    const key = placeCampfire(20, 20);
    const eid = ctx.spawnPawn(21, 20);
    sys.onCampfireBuilt(key);
    ctx._pawnStates.get(eid)!.fireId = key;
    // 记忆里塞 3 条 💥 损失
    const f = ctx.tuning.faction;
    for (let i = 0; i < f.migrateRaidThreshold; i++) sys.addMemory(key, '💥 建筑被摧毁（测试）');
    // 当前有威胁（猫在营地附近）
    ctx.hostiles.push({ x: 22, y: 20, hp: 10, maxHp: 10, targetX: 20, targetY: 20, enemyId: 'cat', name: '野猫' });
    // 加固：同实例跑迁移检查（原先另建 sys2 造成"双实例共享 bus 订阅"的误导性写法）
    for (let i = 0; i < Math.ceil(f.migrateCheckEvery) + 2; i++) sys.update(1);
    // 新增了一个 campfire（迁移）
    const fires = [...ctx.world.buildings.entries()].filter(([, b]) => b.def.id === 'campfire');
    expect(fires.length).toBeGreaterThanOrEqual(2);
  });
});
