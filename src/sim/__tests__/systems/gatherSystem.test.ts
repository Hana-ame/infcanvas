// gatherSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：伐木产出进全局 / 采矿产出进全局 / 采集食物进个人口袋（私有化）/ carryCap 钳制
import { describe, it, expect, beforeEach } from 'vitest';
import { GatherSystem, carryCapOf, capGainTo } from '../../systems/gatherSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';
import { World } from '../../core/world';
import { TILES } from '../../defs';

describe('GatherSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(5);
  beforeEach(() => { ctx = makeMinCtx(5); });

  it('伐木：找到树 → 采完进全局 wood', () => {
    const sys = attach(ctx, new GatherSystem(ctx));
    const eid = ctx.spawnPawn(10, 10);
    const st = ctx._pawnStates.get(eid)!;
    // 手动开启砍树（设定 chopXY 到树位置）
    const tree = (() => { for (let x = 0; x < ctx.world.width; x++) for (let y = 0; y < ctx.world.height; y++) { const t = ctx.world.getTileDef(x, y); if (t.growable) return { x, y }; } return null; })();
    if (!tree) throw new Error('测试世界应有树');
    st.chopXY = { x: tree.x, y: tree.y };
    st.chopProgress = 0;
    ctx.setPosition(eid, { x: tree.x, y: tree.y });
    const woodBefore = ctx.stockpile.wood ?? 0;
    // 伐木需要 harvest.time 秒
    const time = ctx.world.getTileDef(tree.x, tree.y).harvest?.time ?? ctx.tuning.gather.chopTime;
    for (let i = 0; i < Math.ceil(time) + 2; i++) sys.update(1);
    expect((ctx.stockpile.wood ?? 0)).toBeGreaterThan(woodBefore);
    expect(st.chopXY).toBeUndefined(); // 采完清除目标
  });

  it('采集食物（growable harvest 产物 food）→ 进个人口袋（私有化）', () => {
    // 背景：默认 TILES 无产 food 的 tile（树→wood、矿→ore），旧版此用例的条件式断言
    // 从未走到私有化分支（假通过）。加固：自定义 World 注入产 food 的浆果丛 tile，
    // 真实触发 gatherSystem 的私有化路径（food 进个人 inventory、不进全局 stockpile）。
    const berryWorld = new World(5, { tiles: {
      ...TILES,
      berry: { id: 'berry', name: '浆果丛', passable: true, buildable: false, growable: true, color: '#a44',
        harvest: { product: 'food', time: 0.5, yieldSuccess: 5, yieldFail: 1, dc: 10 } },
    } });
    const ctxB = makeMinCtx(5, { world: berryWorld });
    berryWorld.setTile(10, 10, 'berry');
    const sys = attach(ctxB, new GatherSystem(ctxB));
    const eid = ctxB.spawnPawn(10, 10);
    const st = ctxB._pawnStates.get(eid)!;
    st.chopXY = { x: 10, y: 10 };
    st.chopProgress = 0;
    for (let i = 0; i < 4; i++) sys.update(1); // time=0.5s，跑 4s 必采完
    const st2 = ctxB._pawnStates.get(eid)!;
    expect(st2.chopXY).toBeUndefined(); // 采完
    expect((st2.inventory?.['food'] ?? 0)).toBeGreaterThan(0); // 食物进个人口袋
    expect(ctxB.stockpile.food ?? 0).toBe(0); // 不进全局
  });

  it('carryCapOf / capGainTo：负重钳制工具函数', () => {
    const g = ctx.tuning.gather;
    const cap = carryCapOf(g, g.strBase); // siz == strBase → 基础负重
    expect(cap).toBe(g.carryBase);
    const big = carryCapOf(g, 99); // 大块头 → 更高负重
    expect(big).toBeGreaterThan(g.carryBase);
    // 钳制：超上限压到 cap；负值归 0；至少 1
    expect(capGainTo(1000, cap)).toBe(Math.floor(cap));
    expect(capGainTo(-5, cap)).toBe(0);
    expect(capGainTo(0.5, 10)).toBe(0.5); // 小数原样（不做取整，钳制只限制上限）
  });
});
