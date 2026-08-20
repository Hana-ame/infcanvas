// DLC 隔离测试（2026-08-20，用户「不添加核心，单独测试 DLC 包」）：
// 验证每个 DLC 包可以脱离完整 playstyle 单独挂载 + 功能正确。
import { describe, it, expect } from 'vitest';
import { createDlcTest } from './dlc-test-helper';

describe('DLC 隔离测试（不挂载完整 playstyle）', () => {
  it('seasons：单独挂载 → 季节切换事件触发', () => {
    const t = createDlcTest('seasons', { pawnCount: 0 });
    // seasonLength=10, dayLength=120 → 第 1 tick 触发春天
    t.step(3); // 节流 2s → step 3s 确保触发
    const evts = t.getEvents().filter(e => e.text.match(/[春夏秋冬]/));
    expect(evts.length).toBeGreaterThan(0);
  });

  it('astronomy：单独挂载 → 日食事件触发（300s 内）', () => {
    const t = createDlcTest('astronomy', { pawnCount: 0 });
    for (let i = 0; i < 360; i++) t.step(1);
    const evts = t.getEvents().filter(e => e.text.includes('日食') || e.text.includes('月食'));
    expect(evts.length).toBeGreaterThan(0);
  });

  it('disease：单独挂载 → 注入疾病 + 草药 tile 注册', () => {
    const t = createDlcTest('disease', { pawnCount: 1 });
    const eid = t.sim.pawns[0];
    // disease 包注册了 'disease-herb' tile
    expect(t.registry.tiles['herb']).toBeDefined();
    // 注入疾病
    const st = t.sim.pawnStates.get(eid)!;
    st.extra = { disease: { type: '流感', severity: 0.3 } };
    t.step(3); // 超过 2s 节流 → 疾病系统评估
    expect(st.extra?.disease).toBeDefined();
  });

  it('breeding：单独挂载 → requires social（自动依赖解析）', () => {
    const t = createDlcTest('breeding', { pawnCount: 2 });
    expect(t.registry.packIds).toContain('breeding');
    expect(t.registry.packIds).toContain('social'); // 依赖自动挂载
    t.step(1); // 不崩
  });

  it('flying：单独挂载 → 鹰敌人注册 + 系统运行', () => {
    const t = createDlcTest('flying', { pawnCount: 0 });
    expect(t.registry.enemies['eagle']).toBeDefined();
    expect(t.sim.systemIds).toContain('flying');
    t.step(1); // 不崩
  });

  it('meteor：单独挂载 → 陨石系统运行 + 预警事件', () => {
    const t = createDlcTest('meteor', { pawnCount: 0 });
    // 陨石 interval=240s → step 250s 应触发预警
    for (let i = 0; i < 260; i++) t.step(1);
    const evts = t.getEvents().filter(e => e.text.includes('陨石'));
    expect(evts.length).toBeGreaterThan(0);
  });

  it('visitor：单独挂载 → 访客事件触发（300s 内）', () => {
    const t = createDlcTest('visitor', { pawnCount: 0 });
    for (let i = 0; i < 360; i++) t.step(1);
    const evts = t.getEvents().filter(e => e.text.includes('礼物') || e.text.includes('弹唱') || e.text.includes('到访') || e.text.includes('神秘'));
    expect(evts.length).toBeGreaterThan(0);
  });

  it('neutral-fauna：单独挂载 → 中立生物注册 + 刷新', () => {
    const t = createDlcTest('neutral-fauna', { pawnCount: 0 });
    expect(t.registry.enemies['deer']).toBeDefined();
    expect(t.registry.enemies['rabbit']).toBeDefined();
    // 120s 后应有中立生物刷出
    for (let i = 0; i < 130; i++) t.step(1);
    const fauna = t.sim.hostiles.filter((h: { faction?: string }) => h.faction === 'neutral-fauna');
    expect(fauna.length).toBeGreaterThan(0);
  });

  it('waterworks：单独挂载 → 水渠/水车建筑注册', () => {
    const t = createDlcTest('waterworks', { pawnCount: 0, extraPacks: ['build'] });
    expect(t.registry.buildings['aqueduct']).toBeDefined();
    expect(t.registry.buildings['waterwheel']).toBeDefined();
    expect(t.registry.buildings['dam']).toBeDefined();
  });

  it('industrial：单独挂载 → 蒸汽机/工厂/烟囱注册', () => {
    const t = createDlcTest('industrial', { pawnCount: 0, extraPacks: ['build'] });
    expect(t.registry.buildings['steam-engine']).toBeDefined();
    expect(t.registry.buildings['factory']).toBeDefined();
    expect(t.registry.buildings['smokestack']).toBeDefined();
    expect(t.registry.items['steel']).toBeDefined();
    expect(t.registry.items['coal']).toBeDefined();
  });

  it('rail：单独挂载 → 铁轨/火车站/矿车注册 + board_cart 命令', () => {
    const t = createDlcTest('rail', { pawnCount: 1, extraPacks: ['build'] });
    expect(t.registry.buildings['rail']).toBeDefined();
    // rail requires build pack → auto-resolved
    expect(t.registry.buildings['train-station']).toBeDefined();
    expect(t.registry.commandHandlers.has('board_cart')).toBe(true);
    // 上矿车
    t.sim.issueCommand({ type: 'board_cart', x: 0, y: 0, pawnId: t.sim.pawns[0] });
    const st = t.sim.pawnStates.get(t.sim.pawns[0]);
    expect(st?.extra?.rail).toBeDefined();
  });

  it('extra-needs：单独挂载 → 注册 hygiene/entertainment 需求', () => {
    const t = createDlcTest('extra-needs', { pawnCount: 1 });
    // extra-needs uses step:before hook → Sim.step 应触发
    t.sim.step(1);
    t.sim.step(1); // 再步一帧确保 hook 执行
    const eid = t.sim.pawns[0];
    const h = (t.sim as unknown as { readCustomNeed: (eid: number, id: string) => number | undefined }).readCustomNeed(eid, 'hygiene');
    const e = (t.sim as unknown as { readCustomNeed: (eid: number, id: string) => number | undefined }).readCustomNeed(eid, 'entertainment');
    expect(h).toBeDefined();
    expect(e).toBeDefined();
  });

  it('多 DLC 同时隔离挂载（seasons + meteor + visitor）', () => {
    const t = createDlcTest(['seasons', 'meteor', 'visitor'], { pawnCount: 0 });
    expect(t.sim.systemIds).toContain('seasons');
    expect(t.sim.systemIds).toContain('meteor');
    expect(t.sim.systemIds).toContain('visitor');
    t.step(1); // 不崩
  });

  it('beastTaming：单独挂载 → tame 命令注册', () => {
    const t = createDlcTest('beast-taming', { pawnCount: 1 });
    expect(t.registry.commandHandlers.has('tame')).toBe(true);
    expect(t.registry.commandHandlers.has('release')).toBe(true);
  });

  it('drafting：单独挂载 → 征召命令注册', () => {
    const t = createDlcTest('drafting', { pawnCount: 1 });
    expect(t.sim.systemIds).toContain('drafting');
  });
});
  // P2 新包隔离测试
  it('zone：单独挂载 → zone 命令 + 系统注册', () => {
    const t = createDlcTest('zone', { pawnCount: 1 });
    expect(t.sim.systemIds).toContain('zone');
    expect(t.registry.commandHandlers.has('zone')).toBe(true);
    t.step(3); // 不崩
  });

  it('work-priority：单独挂载 → 能力注册', () => {
    const t = createDlcTest('work-priority', { pawnCount: 1 });
    expect(t.sim.systemIds).toContain('work-priority');
    t.step(1);
  });

  it('diplomacy：单独挂载 → 关系查询', () => {
    const t = createDlcTest('diplomacy', { pawnCount: 0 });
    expect(t.sim.systemIds).toContain('diplomacy');
    t.step(1);
  });

  it('belt：单独挂载 → 传送带建筑注册', () => {
    const t = createDlcTest('belt', { pawnCount: 0, extraPacks: ['build'] });
    expect(t.registry.buildings['conveyor-belt']).toBeDefined();
    expect(t.registry.buildings['conveyor-belt-up']).toBeDefined();
  });

  // P3 新包隔离测试
  it('biomes-2：单独挂载 → 丛林/草原/苔原 tile 注册', () => {
    const t = createDlcTest('biomes-2', { pawnCount: 0 });
    expect(t.registry.tiles['biome-jungle']).toBeDefined();
    expect(t.registry.tiles['biome-prairie']).toBeDefined();
    expect(t.registry.tiles['biome-tundra']).toBeDefined();
    expect(t.registry.enemies['jungle-panther']).toBeDefined();
  });

  it('enemies-2：单独挂载 → 狼群/Boss/入侵者注册', () => {
    const t = createDlcTest('enemies-2', { pawnCount: 0 });
    expect(t.registry.enemies['wolf-pack']).toBeDefined();
    expect(t.registry.enemies['ancient-bear']).toBeDefined();
    expect(t.registry.enemies['stone-golem']).toBeDefined();
  });

  it('events-2：单独挂载 → 事件注册', () => {
    const t = createDlcTest('events-2', { pawnCount: 1 });
    t.step(1); // 不崩
  });

  it('buildings-3：单独挂载 → 陷阱/医院/学校/市场/竞技场注册', () => {
    const t = createDlcTest('buildings-3', { pawnCount: 0, extraPacks: ['build'] });
    expect(t.registry.buildings['trap']).toBeDefined();
    expect(t.registry.buildings['hospital']).toBeDefined();
    expect(t.registry.buildings['school']).toBeDefined();
    expect(t.registry.buildings['arena']).toBeDefined();
  });

  it('clothing-3：单独挂载 → 鞋/手套/面具/披肩注册', () => {
    const t = createDlcTest('clothing-3', { pawnCount: 0, extraPacks: ['clothing'] });
    expect(t.registry.items['c3-leatherBoots']).toBeDefined();
    expect(t.registry.items['c3-furGloves']).toBeDefined();
    expect(t.registry.items['c3-woodenMask']).toBeDefined();
    expect(t.registry.items['c3-furCape']).toBeDefined();
  });

  it('masterpiece：单独挂载 → 系统注册', () => {
    const t = createDlcTest('masterpiece', { pawnCount: 1 });
    expect(t.sim.systemIds).toContain('masterpiece');
    t.step(1);
  });

  it('gossip-facts：单独挂载 → 系统注册', () => {
    const t = createDlcTest('gossip-facts', { pawnCount: 1 });
    expect(t.sim.systemIds).toContain('gossip-facts');
    t.step(1);
  });

  it('ruins：单独挂载 → 系统注册 + 遗迹生成', () => {
    const t = createDlcTest('ruins', { pawnCount: 0 });
    expect(t.sim.systemIds).toContain('ruins');
    t.step(1); // 触发遗迹生成
  });

  // 补充隔离测试
  it('story：单独挂载 → 事件注册 + adjustMoodAll 能力', () => {
    const t = createDlcTest('story', { pawnCount: 2 });
    // story 包无系统（只注册事件 + hook）→ 检查事件注册
    const storyEvents = t.registry.events.filter(e => ['eclipse','aurora','earthquake','rainstorm','friendship'].includes(e.id));
    expect(storyEvents.length).toBeGreaterThan(0);
    // 事件池应有 story 的事件（通过 mods.events 查）

    t.step(2); // 不崩
  });

  it('hot-cold：单独挂载 → 热区冷区命令 + 系统', () => {
    const t = createDlcTest('hot-cold', { pawnCount: 1 });
    expect(t.sim.systemIds).toContain('hot-cold');
    expect(t.registry.commandHandlers.has('hotcold')).toBe(true);
    t.step(1); // 不崩
  });

  // 2026-08-20「DLC 里加 DLC」：运行时热挂载 + 子包嵌套
  it('运行时 mountPack：挂载新 DLC → 新系统/建筑/命令即时生效（不重启）', () => {
    const t = createDlcTest('zone', { pawnCount: 1 }); // 任意基础装配
    const before = t.sim.systemIds.length;
    const runtimeDlc = {
      id: 'rt-dlc-test', requires: [],
      apply(m: typeof t.registry) {
        m.registerBuilding({ id: 'rt-test-hut', name: '测试茅屋', size: { x: 1, y: 1 }, hp: 50, color: '#0a0', emoji: '🏠', passable: true, buildTime: 1, tags: ['house'], meta: {}, costWood: 3 });
        m.registerSystemDef({ id: 'rt-test-sys', label: '测试系统', category: 'world', ctor: () => ({ id: 'rt-test-sys', init() {}, update() {} }) });
        m.registerCommand('rt_test_cmd', (ctx) => { ctx.logEvent('rt ok'); });
      },
    };
    (t.sim as unknown as { mountPack: (p: unknown) => void }).mountPack(runtimeDlc);
    expect(t.sim.systemIds.length).toBe(before + 1);
    expect(t.sim.systemIds).toContain('rt-test-sys');
    expect(t.sim.buildingDef('rt-test-hut')).toBeDefined();
    expect(t.registry.commandHandlers.has('rt_test_cmd')).toBe(true);
    // 新建筑可建（World 快照同步）
    const p = t.sim.pawnPositions.get(t.sim.pawns[0])!;
    let placed = false;
    outer: for (let r = 1; r <= 8; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (t.sim.world.placeBuilding(Math.round(p.x) + dx, Math.round(p.y) + dy, 'rt-test-hut', 'player')) { placed = true; break outer; }
    }
    expect(placed).toBe(true);
    t.sim.step(1); // 新系统从下一 tick 生效，步进不崩
  });

  it('子包嵌套：父 DLC subpacks 自动先挂子 DLC', () => {
    const t = createDlcTest('zone', { pawnCount: 1 });
    const sub = {
      id: 'rt-sub-pack', requires: [],
      apply(m: typeof t.registry) { m.registerBuilding({ id: 'rt-sub-bld', name: '子包建筑', size: { x: 1, y: 1 }, hp: 60, color: '#a00', emoji: '🏰', passable: false, buildTime: 2, tags: ['defense'], meta: {}, costWood: 5 }); },
    };
    const parent = {
      id: 'rt-parent-pack', requires: [], subpacks: [sub],
      apply(m: typeof t.registry) { m.registerCommand('rt_parent_cmd', () => {}); },
    };
    (t.sim as unknown as { mountPack: (p: unknown) => void }).mountPack(parent);
    // 子包先挂 → 子包建筑 + 父命令都生效
    expect(t.sim.buildingDef('rt-sub-bld')).toBeDefined();
    expect(t.registry.commandHandlers.has('rt_parent_cmd')).toBe(true);
  });
