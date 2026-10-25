import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ModRegistry, DLC_CATALOG, isAiModeDlcEnabled, toggleSimDlc } from '../mods';
import {
  ARCHITECT_BUILDABLES,
  ITEM_WEIGHT_KG,
  KIDNAP_REP_PENALTY,
  MAX_BOUND_TRIADS,
  SLOPE_LADDER_SPEED_PENALTY_MUL,
  STEAL_REP_PENALTY,
  Sim,
  SpatialHashGrid,
  UNBOUND_ACTION_EFFICIENCY_MUL,
  assignPawnToGroup,
  benchmarkHundredPawnsSim,
  canTraverseElevationWithSlope,
  constructBlueprint,
  enforceSingleTileOccupancy,
  evaluatePawnActionEfficiency,
  executeZeroPriceGroupTrade,
  getColonistGroups,
  getFactionBehaviorByRelation,
  getNpcBases,
  getRuinScavengeableBuildings,
  getRuinSites,
  getSelectableObjectAt,
  hasLineOfSight,
  haulAndButcherCorpse,
  inspectCorpseLootManifest,
  inspectFootprintCells,
  isOutsidePlayerFieldOfView,
  isTileOccupiedBySelectable,
  kidnapFromFaction,
  lootSelectedFromCorpse,
  performPawnTriadAction,
  placeArchitectBuilding,
  placeArchitectBlueprint,
  CULINARY_INGREDIENTS,
  CULINARY_RECIPES,
  consumeCulinaryDish,
  cookCulinaryDish,
  getActiveCulinaryBuff,
  inspectRoomAt,
  isExteriorOnlyBuilding,
  isInteriorRoomBuilding,
  orderScavengeRuinBuilding,
  scavengeRuinBuilding,
  scavengeRuinSite,
  tickRimWorldScavengeOrders,
  setPawnBoundTriads,
  setSimCameraViewport,
  spawnHundredPawnColony,
  spawnWildAnimalOutsideView,
  spreadPlantsStep,
  stealFromFaction,
} from '../sim';
import { svgIcon } from '../client/ui-icons';

describe('RimWorld + Online MMO 全新机制与工程化拆分求证测试套件', () => {
  it('1. 地形斜坡图标与移速规则：斜坡边缘虚化（无箭头 polyline）且连通 z±1、经过斜坡有移速系数计算', () => {
    const iconHtml = svgIcon('slope', 20);
    expect(iconHtml).toContain('data-icon="transparent-ladder"');
    expect(iconHtml).toContain('rgba(');
    expect(iconHtml).not.toContain('polyline');
    expect(SLOPE_LADDER_SPEED_PENALTY_MUL).toBeGreaterThan(1.0);

    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 100;
    sim.stockpile['stone'] = 100;

    // 在 (2, 0) 放置地形斜坡
    const res = placeArchitectBuilding(sim, 'slope', 2, 0, 0, 'p_local_1');
    expect(res.ok).toBe(true);

    // 检查通过斜坡时的移速系数
    const trav = canTraverseElevationWithSlope(sim.world, 1, 0, 2, 0, false);
    expect(trav.allowed).toBe(true);
    expect(trav.viaSlope).toBe(true);
    expect(trav.speedPenaltyMul).toBeCloseTo(SLOPE_LADDER_SPEED_PENALTY_MUL, 2);

    // 验证实际步进时站在斜坡格比普通平地移速更慢
    const p1 = sim.pawn(sim.spawnPawn(2, 0))!;
    const p2 = sim.pawn(sim.spawnPawn(0, 2))!;
    p1.path = [{ x: 3, y: 0 }];
    p2.path = [{ x: 1, y: 2 }];
    sim.moveStep(p1, 0.1);
    sim.moveStep(p2, 0.1);
    const movedOnSlope = p1.pos.x - 2;
    const movedOnFlat = p2.pos.x - 0;
    expect(movedOnSlope).toBeLessThan(movedOnFlat);
  });

  it('2. 鼠鼠寻路仅判断可通过性，不判断移速：无视地形移速差异，直接走最短可通行路径', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    const p = [...sim.pawns()][0];
    p.pos = { x: 0, y: 0 };

    const ok = sim.setPath(p, 5, 0);
    expect(ok).toBe(true);
    expect(p.path.length).toBe(5);
    for (const step of p.path) {
      expect(step.y).toBe(0);
    }
  });

  it('3. 支持 1×1、2×1、1×2、2×2、5×5 多格占地与 R 键 90° 朝向旋转；玩家模式全面屏蔽 AI 自主建房；AImode 移入 DLC 默认不开启', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 500;
    sim.stockpile['stone'] = 500;
    sim.stockpile['ore'] = 500;

    const sizes = new Set(ARCHITECT_BUILDABLES.map((b) => `${b.w}x${b.h}`));
    expect(sizes.has('1x1')).toBe(true);
    expect(sizes.has('2x1')).toBe(true);
    expect(sizes.has('1x2')).toBe(true);
    expect(sizes.has('2x2')).toBe(true);
    expect(sizes.has('5x5')).toBe(true);

    const rot0 = inspectFootprintCells(sim, 'stove', 2, 2, 0);
    const rot1 = inspectFootprintCells(sim, 'stove', 2, 2, 1);
    expect([rot0.w, rot0.h]).toEqual([2, 1]);
    expect([rot1.w, rot1.h]).toEqual([1, 2]);

    const check5x5 = inspectFootprintCells(sim, 'citadel_hub', -4, -4, 0);
    expect([check5x5.w, check5x5.h]).toEqual([5, 5]);
    expect(check5x5.cells.length).toBe(25);

    const activeCards = sim.cards();
    expect(activeCards.some((c) => c.id.startsWith('build_') || c.series === 'build')).toBe(false);

    const aiDlcMeta = DLC_CATALOG.find((d) => d.id === 'dlc-ai-director');
    expect(aiDlcMeta).toBeDefined();
    expect(aiDlcMeta?.defaultEnabled).toBe(false);
    expect(isAiModeDlcEnabled(sim)).toBe(false);

    toggleSimDlc(sim, 'dlc-ai-director', true);
    expect(isAiModeDlcEnabled(sim)).toBe(true);
    expect(sim.cards().some((c) => c.id.startsWith('build_'))).toBe(true);
  });

  it('4. 技能/特质/熟练度三者绑定：每人最多 3 项绑定，非绑定操作一律效率 ×50% 且无法学习', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    const p = [...sim.pawns()][0];

    const triads = setPawnBoundTriads(p, [
      'mining_construct',
      'combat_shoot',
      'plants_cook',
      'medical_social',
      'research_craft',
    ]);
    expect(triads.length).toBe(MAX_BOUND_TRIADS);
    expect(p.boundTraits?.length).toBe(MAX_BOUND_TRIADS);

    const boundEval = evaluatePawnActionEfficiency(p, 'mining_construct');
    expect(boundEval.isBound).toBe(true);
    expect(boundEval.canLearn).toBe(true);
    expect(boundEval.efficiencyMul).toBeGreaterThanOrEqual(1.0);

    const boundAct = performPawnTriadAction(p, 'mining_construct', 100, sim.time);
    expect(boundAct.isBound).toBe(true);
    expect(boundAct.canLearn).toBe(true);
    expect(boundAct.xpGained).toBeGreaterThan(0);
    expect(boundAct.masteryGained).toBeGreaterThan(0);

    const unboundEval = evaluatePawnActionEfficiency(p, 'research_craft');
    expect(unboundEval.isBound).toBe(false);
    expect(unboundEval.canLearn).toBe(false);
    expect(unboundEval.efficiencyMul).toBeCloseTo(UNBOUND_ACTION_EFFICIENCY_MUL, 5);

    const unboundAct = performPawnTriadAction(p, 'research_craft', 100, sim.time);
    expect(unboundAct.isBound).toBe(false);
    expect(unboundAct.canLearn).toBe(false);
    expect(unboundAct.efficiencyMul).toBeCloseTo(0.5, 5);
    expect(unboundAct.effectiveWorkDone).toBeCloseTo(50, 5);
    expect(unboundAct.xpGained).toBe(0);
    expect(unboundAct.masteryGained).toBe(0);
  });

  it('5. 远古遗迹建筑搜刮点：存在多处遗迹搜刮点，派遣小人搜刮可带回高价值战利品并计入分组载重', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    const ruins = getRuinSites(sim);
    expect(ruins.size).toBeGreaterThanOrEqual(4);

    const firstRuin = [...ruins.values()][0];
    expect(firstRuin.explored).toBe(false);

    const actor = [...sim.pawns()][0];
    const res = scavengeRuinSite(sim, firstRuin.id, actor.eid);
    expect(res.ok).toBe(true);
    expect(Object.keys(res.looted).length).toBeGreaterThan(0);
    expect(res.addedWeightKg).toBeGreaterThan(0);
    expect(firstRuin.explored).toBe(true);
  });

  it('6. 遗体弹窗选择带出物品与载重校验：可按需勾选带出部分物品，超重时拒绝，全部带走后清理遗体', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    const victimEid = sim.spawnPawn(3, 3);
    const victim = sim.pawn(victimEid)!;
    victim.name = '遇难探险家';
    victim.equipWeapon = '脉冲步枪';
    victim.equipApparel = '动力装甲';
    victim.inventory = { gold: 4, food: 6 };
    sim.killPawn(victimEid, '战斗阵亡');

    const manifest = inspectCorpseLootManifest(sim, victimEid);
    expect(manifest).not.toBeNull();
    expect(manifest!.entries.length).toBe(4);

    const looter = [...sim.pawns()][0];
    const step1 = lootSelectedFromCorpse(sim, victimEid, looter.eid, [
      { key: 'weapon', qty: 1 },
      { key: 'gold', qty: 2 },
    ]);
    expect(step1.ok).toBe(true);
    expect(step1.corpseFullyStripped).toBe(false);

    const manifestAfter = inspectCorpseLootManifest(sim, victimEid)!;
    expect(manifestAfter.entries.find((e) => e.key === 'gold')?.availableQty).toBe(2);

    const step2 = lootSelectedFromCorpse(
      sim,
      victimEid,
      looter.eid,
      manifestAfter.entries.map((e) => ({ key: e.key, qty: e.availableQty })),
    );
    expect(step2.ok).toBe(true);
    expect(step2.corpseFullyStripped).toBe(true);
    expect(sim.deadPawnMap.has(victimEid)).toBe(false);
  });

  it('7. 殖民者多分组独立财产分配与 Price=0 交易面板（含严格载重上限计算）', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    const groups = getColonistGroups(sim);
    expect(groups.size).toBeGreaterThanOrEqual(3);

    const pawns = [...sim.pawns()];
    assignPawnToGroup(sim, pawns[0].eid, 'group_alpha');
    assignPawnToGroup(sim, pawns[1].eid, 'group_beta');

    const alpha = groups.get('group_alpha')!;
    const beta = groups.get('group_beta')!;
    const woodBefore = beta.inventory['wood'] ?? 0;

    const tradeOk = executeZeroPriceGroupTrade(sim, 'group_alpha', 'group_beta', [{ item: 'wood', qty: 5 }]);
    expect(tradeOk.ok).toBe(true);
    expect(tradeOk.price).toBe(0);
    expect(beta.inventory['wood']).toBe(woodBefore + 5);
    expect(tradeOk.transferredWeightKg).toBeCloseTo(5 * ITEM_WEIGHT_KG.wood, 3);

    alpha.inventory['ore'] = 500;
    const tradeOverweight = executeZeroPriceGroupTrade(sim, 'group_alpha', 'group_beta', [{ item: 'ore', qty: 400 }]);
    expect(tradeOverweight.ok).toBe(false);
    expect(tradeOverweight.message).toContain('载重不足');
  });

  it('8. Online MMO 跨阵营玩法：盗窃 (-25好感) 与绑架 (-45好感) 自动降低好感度，不同关系等级对应不同做法', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    const bases = getNpcBases(sim);
    const acorn = bases.get('base_acorn_bazaar')!;
    const initRep = acorn.reputation;
    expect(getFactionBehaviorByRelation(initRep).tier).toBe('ally');

    const actor = [...sim.pawns()][0];
    const stealRes = stealFromFaction(sim, acorn.id, actor.eid);
    expect(stealRes.ok).toBe(true);
    expect(stealRes.repAfter).toBe(initRep + STEAL_REP_PENALTY);

    const kidnapRes = kidnapFromFaction(sim, acorn.id, actor.eid);
    expect(kidnapRes.ok).toBe(true);
    expect(kidnapRes.repAfter).toBe(initRep + STEAL_REP_PENALTY + KIDNAP_REP_PENALTY);
    expect(kidnapRes.relationTierAfter).toBe('hostile');
    expect(acorn.attitude).toBe('hostile');
    expect(kidnapRes.kidnappedPawnEid).toBeDefined();
    expect(sim.pawn(kidnapRes.kidnappedPawnEid!)).toBeDefined();

    expect(getFactionBehaviorByRelation(60).canRequestAid).toBe(true);
    expect(getFactionBehaviorByRelation(0).canTrade).toBe(true);
    expect(getFactionBehaviorByRelation(-40).shootsOnSight).toBe(true);
    expect(getFactionBehaviorByRelation(-85).sendsRetaliationRaids).toBe(true);
  });

  it('9. 百人同屏计算效率与工程化代码拆分校验：100 人同屏极速步进且拆分后核心模块均保持精简', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    const total = spawnHundredPawnColony(sim, 100);
    expect(total).toBeGreaterThanOrEqual(100);

    const bench = benchmarkHundredPawnsSim(sim, 15);
    expect(bench.pawnCount).toBeGreaterThanOrEqual(100);
    expect(bench.avgMsPerTick).toBeLessThan(25);

    const grid = new SpatialHashGrid<{ id: number }>(8);
    grid.insert(10, 10, { id: 1 });
    grid.insert(12, 11, { id: 2 });
    grid.insert(90, 90, { id: 3 });
    const near: { id: number }[] = [];
    grid.queryRadius(10, 10, 5, near);
    expect(near.length).toBe(2);

    const rootDir = path.resolve(__dirname, '..');
    const filesToCheck = [
      'client/rimworld-ui.ts',
      'client/ui-drawers.ts',
      'client/ui-modals.ts',
      'client/ui-icons.ts',
      'client/render.ts',
      'client/render-buildings.ts',
      'client/render-entities.ts',
      'sim/sim.ts',
      'sim/sim-commands.ts',
      'sim/triad-specialization.ts',
      'sim/mmo-groups-ruins.ts',
      'sim/spatial-grid.ts',
      'sim/rimworld-ecology-butcher.ts',
    ];
    for (const rel of filesToCheck) {
      const content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
      const lines = content.split('\n').length;
      expect(lines).toBeLessThan(800);
    }
  });

  it('10. 高差视野 (低处不能看高处)、斜坡连通 z±1、以及分组初始化完整性校验', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');

    let foundPair = false;
    for (let y = -40; y <= 40 && !foundPair; y++) {
      for (let x = -40; x <= 40 && !foundPair; x++) {
        const z0 = sim.world.zAt(x, y);
        const z1 = sim.world.zAt(x + 3, y);
        if (z0 >= 1 && z1 > z0) {
          foundPair = true;
          expect(hasLineOfSight(sim.world, x, y, x + 3, y)).toBe(false);
        }
      }
    }
    expect(foundPair).toBe(true);

    getColonistGroups(sim);
    const newEid = sim.spawnPawn(1, 1);
    getColonistGroups(sim);
    expect(sim.pawn(newEid)?.groupId).toBe('group_alpha');
  });

  it('11. 生成顺序、替代规则与单格唯一对象校验：建筑自动替代覆盖格植物、墙门同格替代、单格至多一个建筑/实体/可选中对象', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 200;
    sim.stockpile['ore'] = 100;

    // 1. 在 (3, 1) 植一株野生浆果丛，然后放置建筑覆盖该格：浆果丛应被建筑替代清除，不共存
    sim.world.addSpreadPlant(3, 1, 'berry', 4);
    expect(sim.world.featureAt(3, 1)?.kind).toBe('berry');

    const wallRes = placeArchitectBuilding(sim, 'wall', 3, 1, 0, 'p_local_1');
    expect(wallRes.ok).toBe(true);
    expect(sim.world.buildingAt(3, 1)?.defId).toBe('wall');
    expect(sim.world.featureAt(3, 1)).toBeNull();

    // 2. 在已有围墙 (3, 1) 上直接规划自动门 (door)：遵循 RimWorld 墙门同格替代规则
    const doorRes = placeArchitectBuilding(sim, 'door', 3, 1, 0, 'p_local_1');
    expect(doorRes.ok).toBe(true);
    expect(sim.world.buildingAt(3, 1)?.defId).toBe('door');

    // 3. 蓝图同格替代：在同一格放置新蓝图可替代旧蓝图，绝不产生双建筑叠加
    const bp1 = placeArchitectBlueprint(sim, 'wall', 4, 1, 0, 'p_local_1');
    expect(bp1.ok).toBe(true);
    const bp2 = placeArchitectBlueprint(sim, 'door', 4, 1, 0, 'p_local_1');
    expect(bp2.ok).toBe(true);
    expect(sim.world.buildingAt(4, 1)?.defId).toBe('door');

    // 4. 全局单格唯一性校验：任意两个小人/动物/尸体/建筑绝不叠在同一整数格
    enforceSingleTileOccupancy(sim);
    const occupiedCoords = new Set<string>();
    for (const p of sim.pawns()) {
      const k = `${Math.round(p.pos.x)},${Math.round(p.pos.y)}`;
      expect(occupiedCoords.has(k)).toBe(false);
      occupiedCoords.add(k);
      expect(getSelectableObjectAt(sim, p.pos.x, p.pos.y)?.kind).toBe('pawn');
    }
  });

  it('12. 小动物视野外生成与植物自然蔓延机制：小动物必在视野与视口外生成，成熟植物向周围空置肥沃地块蔓延', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    setSimCameraViewport(sim, { x0: -18, y0: -14, x1: 18, y1: 14 });

    // 1. 验证小动物在视野与视口之外生成
    const animal = spawnWildAnimalOutsideView(sim, 'rabbit');
    expect(animal).not.toBeNull();
    expect(isOutsidePlayerFieldOfView(sim, animal!.pos.x, animal!.pos.y)).toBe(true);

    // 2. 验证植物蔓延机制：向周围无建筑、无实体的肥沃地块繁衍新植物
    const spreadRes = spreadPlantsStep(sim, { maxNewPlants: 2 });
    expect(spreadRes.spreadCount).toBeGreaterThan(0);
    for (const np of spreadRes.newPlants) {
      expect(sim.world.featureAt(np.x, np.y)).not.toBeNull();
      expect(sim.world.buildingAt(np.x, np.y)).toBeUndefined();
    }
  });

  it('13. 生物死亡产生尸体并拖回屠宰台屠宰分解（与 RimWorld 一致：击杀不直接刷肉，拖回屠宰后产出肉与毛皮）', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 100;
    sim.stockpile['ore'] = 50;

    // 建造一座 2×1 屠宰工作台 (butcher_table)
    const tableRes = placeArchitectBuilding(sim, 'butcher_table', -3, -2, 0, 'p_local_1');
    expect(tableRes.ok).toBe(true);

    const meatBefore = sim.stockpile['meat'] ?? 0;
    const leatherBefore = sim.stockpile['leather'] ?? 0;

    // 刷出一只野鹿并击杀：死亡瞬间不直接加肉，而是在原地生成野鹿尸体
    const deer = sim.spawnHostile('deer', 6, 4);
    sim.damageHostile(deer.id, 999);
    expect(sim.stockpile['meat'] ?? 0).toBe(meatBefore);

    const deerCorpse = [...sim.deadPawnMap.values()].find((c) => c.isAnimalCorpse && c.animalKind === 'deer');
    expect(deerCorpse).toBeDefined();
    expect(isTileOccupiedBySelectable(sim, deerCorpse!.pos.x, deerCorpse!.pos.y)).toBe(true);

    // 将野鹿尸体拖回屠宰工作台屠宰分解：获得生肉 (meat)、毛皮 (leather) 与鹿茸药草 (herb)，尸体销毁
    const actor = [...sim.pawns()][0];
    const butcherRes = haulAndButcherCorpse(sim, deerCorpse!.eid, actor.eid);
    expect(butcherRes.ok).toBe(true);
    expect(butcherRes.butcherBuildingId).toBe(tableRes.building!.id);
    expect(sim.stockpile['meat'] ?? 0).toBeGreaterThan(meatBefore);
    expect(sim.stockpile['leather'] ?? 0).toBeGreaterThan(leatherBefore);
    expect(sim.deadPawnMap.has(deerCorpse!.eid)).toBe(false);
  });

  it('14. 墙壁蓝图通行与完工实体化逻辑 + 遗迹内部具体建筑独立搜刮（储物柜/物资箱/实验终端）', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 100;

    // 1. 墙壁蓝图在未施工完成前保持可通行，完工后变为不可通行实体墙
    const wallBp = placeArchitectBlueprint(sim, 'wall', 5, 0, 0, 'p_local_1');
    expect(wallBp.ok).toBe(true);
    expect(wallBp.building!.isBlueprint).toBe(true);
    expect(sim.world.canStand(5, 0)).toBe(true);

    const actor = [...sim.pawns()][0];
    const buildDone = constructBlueprint(sim, wallBp.building!.id, actor.eid, 100);
    expect(buildDone.ok).toBe(true);
    expect(buildDone.completed).toBe(true);
    expect(wallBp.building!.isBlueprint).toBe(false);
    expect(sim.world.canStand(5, 0)).toBe(false);

    // 2. 遗迹内生成具体的可搜刮建筑，直接对遗迹内的建筑执行搜刮
    const ruinProps = getRuinScavengeableBuildings(sim);
    expect(ruinProps.length).toBeGreaterThanOrEqual(8);
    const targetProp = ruinProps.find((b) => !b.scavenged)!;
    expect(targetProp).toBeDefined();
    expect(targetProp.isRuinBuilding).toBe(true);

    const scavRes = scavengeRuinBuilding(sim, targetProp.id, actor.eid);
    expect(scavRes.ok).toBe(true);
    expect(targetProp.scavenged).toBe(true);
    expect(Object.keys(scavRes.gained).length).toBeGreaterThan(0);
  });

  it('15. 搜刮不能隔空搜刮：远处下达搜刮指令时不会隔空瞬移拿走物资，必须派遣小人走到贴身范围后读条完成搜刮', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    const ruinProps = getRuinScavengeableBuildings(sim);
    const targetProp = ruinProps.find((b) => !b.scavenged)!;
    const actor = [...sim.pawns()][0];
    actor.pos = { x: 0, y: 0 };

    // 演员在 (0,0)，距离遗迹建筑 > 10 格，下达非隔空搜刮指令：返回 ok: false, dispatched: true，建筑尚未被搜空
    const remoteAttempt = orderScavengeRuinBuilding(sim, targetProp.id, actor.eid);
    expect(remoteAttempt.ok).toBe(false);
    expect(remoteAttempt.dispatched).toBe(true);
    expect(targetProp.scavenged).toBe(false);
    expect(actor.scavengeOrder?.targetId).toBe(targetProp.id);

    // 将小人移动到遗迹建筑紧邻格并推进搜刮读条
    const adj = sim.world.nearestBuildingAdjacent(targetProp, actor.pos.x, actor.pos.y) ?? targetProp.pos;
    actor.pos = { x: adj.x, y: adj.y };
    tickRimWorldScavengeOrders(sim, 2.0);
    expect(targetProp.scavenged).toBe(true);
  });

  it('16. 建筑分类与室内外硬约束：直接建造仅限墙壁与门，外部设施（太阳能/风电/灯塔/大篝火）严禁放室内，内设/装饰/工作台需在封闭房间内布置', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 500;
    sim.stockpile['stone'] = 500;
    sim.stockpile['ore'] = 500;
    sim.stockpile['gold'] = 500;
    sim.stockpile['leather'] = 500;

    // 1. 校验结构分类 (structure) 仅包含墙壁、门与斜坡（排除 ruinOnly）
    const structDefs = ARCHITECT_BUILDABLES.filter((b) => b.category === 'structure' && !b.ruinOnly).map((b) => b.defId);
    expect(structDefs).toEqual(['wall', 'door', 'slope']);

    // 2. 校验外部设施分类 (exterior) 包含太阳能、风电、灯塔、大篝火，且标记为 exteriorOnly
    for (const extId of ['solar_generator', 'wind_turbine', 'electric_beacon_tower', 'great_bonfire']) {
      expect(isExteriorOnlyBuilding(extId)).toBe(true);
    }

    // 3. 建造一座 6×6 封闭房间 (x=2..7, y=2..7)
    for (let x = 2; x <= 7; x++) {
      for (let y = 2; y <= 7; y++) {
        if (x === 2 || x === 7 || y === 2 || y === 7) {
          const isDoor = x === 4 && y === 7;
          sim.world.addArchitectBuilding(isDoor ? 'door' : 'wall', x, y, { allowContiguous: true, ignoreTerrain: true });
        }
      }
    }
    const rm = inspectRoomAt(sim.world, 4, 4);
    expect(rm.indoors).toBe(true);
    expect(rm.roofed).toBe(true);

    // 4. 外部设施（太阳能、风电、灯塔、大篝火）严禁放在室内 (4,4)！但在室外 (-6, 4) 可正常放置
    for (const extId of ['solar_generator', 'wind_turbine', 'electric_beacon_tower', 'great_bonfire']) {
      const checkInRoom = inspectFootprintCells(sim, extId, 3, 3, 0);
      expect(checkInRoom.valid).toBe(false);
      expect(checkInRoom.reason).toContain('不能放置在室内');
    }
    const checkOutdoorWind = inspectFootprintCells(sim, 'wind_turbine', -3, -3, 0);
    expect(checkOutdoorWind.valid, checkOutdoorWind.reason).toBe(true);

    // 5. 室内内设/装饰/工作台（bed, plant_pot, art_sculpture, stove, spice_prep_table）在开启 requireIndoorRoom 时严禁放在室外，只能在封闭房间内布置
    for (const intId of ['bed', 'plant_pot', 'art_sculpture', 'stove', 'spice_prep_table']) {
      expect(isInteriorRoomBuilding(intId)).toBe(true);
      const checkOutdoor = inspectFootprintCells(sim, intId, -6, -6, 0, { requireIndoorRoom: true });
      expect(checkOutdoor.valid).toBe(false);
      expect(checkOutdoor.reason).toContain('只能布置在已封顶的封闭房间内');

      sim.world.clearFeaturesInRect(3, 3, 5, 5);
      const checkIndoor = inspectFootprintCells(sim, intId, 3, 3, 0, { requireIndoorRoom: true });
      expect(checkIndoor.valid, checkIndoor.reason).toBe(true);
    }
  });

  it('17. 丰富的食材料理系统：四大类 14 种食材与 10 道特色料理食谱，食用后赋予专属料理风味增益 (Culinary Buff)', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    expect(CULINARY_INGREDIENTS.length).toBeGreaterThanOrEqual(12);
    expect(CULINARY_RECIPES.length).toBeGreaterThanOrEqual(10);

    const pawn = [...sim.pawns()][0];
    pawn.needs.food = 30;
    pawn.needs.mood = 50;

    // 烹制一道「极地九宫格麻辣红油火锅 (dish_polar_spicy_hotpot)」
    const cookRes = cookCulinaryDish(sim, 'dish_polar_spicy_hotpot', pawn.eid);
    expect(cookRes.ok).toBe(true);
    expect(cookRes.gainedQty).toBeGreaterThanOrEqual(3);
    expect(sim.stockpile['dish_polar_spicy_hotpot']).toBeGreaterThanOrEqual(3);

    // 殖民者品尝火锅料理，获得饱食度、心情提升与持续料理 Buff
    const eatRes = consumeCulinaryDish(sim, pawn.eid, 'dish_polar_spicy_hotpot');
    expect(eatRes.ok).toBe(true);
    expect(pawn.needs.food).toBeGreaterThan(80);
    expect(pawn.needs.mood).toBeGreaterThan(65);

    const activeBuff = getActiveCulinaryBuff(pawn, sim.time);
    expect(activeBuff).not.toBeNull();
    expect(activeBuff?.dishId).toBe('dish_polar_spicy_hotpot');
    expect(activeBuff?.moveSpeedPct).toBeGreaterThan(0);
    expect(activeBuff?.workSpeedPct).toBeGreaterThan(0);
    expect(activeBuff?.coldHeatResistC).toBeGreaterThanOrEqual(15);
  });
});
