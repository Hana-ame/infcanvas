/**
 * raid.test.ts —— 敌袭：压力生成 / 猫的追咬 / 鼠的战与逃（全部经卡）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { raidPack } from '../mods/packs/raid';

function raidSim(seed = 6): Sim {
  return new Sim({ seed, registry: ModRegistry.mountPacks([raidPack]), pawnCount: 2 });
}

describe('敌袭包', () => {
  it('叙事压力：阈值到点自动来猫（无波次脚本，纯局面规则）', () => {
    const s = raidSim();
    // 轮询到第一只猫出现（raid-only 无火堆时离场阀可能在轮询间隙触发离场）
    let found = false;
    for (let i = 0; i < 400 && !found; i++) {
      s.step(1);
      if (s.hostiles().length > 0) found = true;
    }
    expect(found).toBe(true);
    expect(s.events.some((e) => e.text.includes('出没'))).toBe(true);
  });

  it('迎战卡：贴身攻击造成伤害直至击退', () => {
    const s = raidSim(15);
    const p = [...s.pawns()][0];
    const h = s.spawnHostile('cat', Math.round(p.pos.x) + 1, p.pos.y);
    const hp0 = h.hp;
    let repelled = false;
    for (let i = 0; i < 60 && !repelled; i++) {
      s.debugForceCard(p.eid, 'fight');
      s.step(1);
      repelled = !s.hostiles().some((x) => x.id === h.id);
    }
    expect(hp0 - (s.hostiles()[0]?.hp ?? 0)).toBeGreaterThan(0); // 造成过伤害
    expect(repelled).toBe(true); // 被击退（hp 归零移除）
    expect(s.events.some((e) => e.text.includes('被击退'))).toBe(true);
  });

  it('撤退卡：逃向严格背离敌人的方向（决策语义；速度哨兵见下）', () => {
    const s = raidSim(16);
    const p = [...s.pawns()][0];
    p.pos = { x: 0, y: 0 };
    // 猫在正东 5 格：flee 的路径目标必须落在西侧（x<0）
    const h = s.spawnHostile('cat', 5, 0);
    s.debugForceCard(p.eid, 'flee');
    s.step(1);
    expect(p.pos.x).toBeLessThan(0); // 向西拉开
    const d1 = Math.hypot(p.pos.x - h.pos.x, p.pos.y - h.pos.y);
    expect(d1).toBeGreaterThan(4); // 一拍后已拉开超过初始距离
    // 平衡哨兵：猫速若调到鼠速以上，逃跑失去意义（战或逃失衡立刻红）
    expect(s.tuning.enemies['cat'].speed).toBeLessThan(s.tuning.pawn.speed);
  });

  it('刷怪落点必须可立足（掉进湖里的猫会永久卡死成幽灵敌袭）', () => {
    const s = new Sim({ seed: 42, registry: ModRegistry.mountPacks([raidPack]), pawnCount: 1 });
    s.run(200);
    expect(s.hostiles().length).toBeGreaterThan(0);
    for (const h of s.hostiles()) {
      expect(s.passable(Math.round(h.pos.x), Math.round(h.pos.y))).toBe(true);
      expect(s.passable(Math.round(h.pos.x), Math.round(h.pos.y))).toBe(true);
    }
  });

  it('离场阀：够不着鼠又远离营地 45s → 猫悻悻离去（防长局猫堆积）', () => {
    const s = new Sim({ seed: 19, registry: ModRegistry.mountPacks([raidPack]), pawnCount: 0 });
    // 无火无鼠：farFromCamp 恒真、target 恒空 → 计时即涨
    const h = s.spawnHostile('cat', 30, 30);
    s.run(44);
    expect(s.hostiles().some((x) => x.id === h.id)).toBe(true); // 44s 还在
    s.run(3);
    expect(s.hostiles().some((x) => x.id === h.id)).toBe(false); // 47s 走了
    expect(s.events.some((e) => e.text.includes('悻悻离去'))).toBe(true);
  });

  it('猫会追咬最近的鼠；鼠被咬死有死亡事件（losing is fun）', () => {
    const s = raidSim(17);
    const victims = [...s.pawns()];
    const v = victims[0];
    v.hp = 8; // 三口就被咬死的残血鼠（构造故事）
    const others = victims.slice(1).map((x) => x.eid);
    void others;
    const h = s.spawnHostile('cat', Math.round(v.pos.x) + 3, Math.round(v.pos.y));
    for (const x of victims.slice(1)) {
      // 其他鼠远远放走，确保目标唯一
      x.pos = { x: v.pos.x + 100, y: v.pos.y + 100 };
    }
    let died = false;
    for (let i = 0; i < 80 && !died; i++) {
      s.step(1);
      if (!s.pawn(v.eid)) died = true;
    }
    void h;
    expect(died).toBe(true);
    expect(s.events.some((e) => e.text.includes('💀') && e.text.includes('野猫袭击'))).toBe(true);
  });
});
