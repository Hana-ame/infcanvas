/**
 * rimworld-advanced-mechanics.test.ts —— 全量验证 16 项 RimWorld 核心与进阶机制测试套件。
 *
 * 覆盖清单：
 *  1. 电网规模损耗与超限 0W 锁定（>32 节点或跨度 >36 格直接拒绝计算，功率锁定为 0W）
 *  2. 战争迷雾（地图拉到最大时 TILE=18 恰好对齐迷雾范围 R=28；电灯塔+大篝火驱散迷雾；否则寻路只做到迷雾范围为止；迷雾跟随 player，不同玩家不共享）
 *  3. 大于 13×13 的房间无法封顶，算作室外（≤13×13 封闭房间正常封顶算室内）
 *  4. 社交只记录最好的 3 个关系、最差的 3 个关系、最好的 3 个派系、最差的 3 个派系（3+3+3+3），其余为临时数据
 *  5. 逐根手指(10根) / 内脏 / 头颅 / 四肢 / 生殖能力(fertilityPct) 独立建模，支持 HP+伤病状态、草药包扎、截肢切除与器官移植
 *  6. 任意小人之间都可以交易，且交易内容 = 主动方在当前地图放到架子(shelf)和 ≤13×13 储藏室的财产 + 小人随身物品 + 驼兽随身物品
 *  7. 野外物品风化速度比原版加速以防卡顿；武器和身上物品在死亡时不从 pawn 上掉落
 *  8. 陌生人隐私保护（看不到陌生人的详细面板，只有特质能看）
 *  9. 人不能穿过山体，也不能透视山里的东西；人物移速减缓且无瞬移
 * 10. z 高度斜坡机制：斜坡占据位置不能有其他建筑；鼠鼠非征召只能从斜坡上下；征召状态可攀爬跳下（耗时 ×2.5 且检定受伤/成功率）
 * 11. 建筑物规划完全交给 player，小人绝不自己决定建造
 */
import { describe, expect, it } from 'vitest';
import {
  Sim,
  placeArchitectBuilding,
  inspectFootprintCells,
  inspectRoomAt,
  evaluatePowerGrids,
  getBuildingPowerGrid,
  getPlayerFogSources,
  isTileVisibleToPlayer,
  clampPathToPlayerFog,
  isSolidMountainAt,
  canTraverseElevationWithSlope,
  hasLineOfSight,
  MAX_POWER_GRID_NODES,
  MAX_POWER_GRID_SPAN,
  MAX_ROOM_SIDE,
  MAX_ZOOM_FOG_RADIUS,
  BODY_PART_DEFS,
  ensurePawnAnatomy,
  computeAnatomyCapacities,
  inflictBodyPartInjury,
  bandageBodyPartWithHerb,
  amputateBodyPart,
  transplantBodyPart,
  getBoundedSocialSummary,
  getTradeablePropertyForPawn,
  executePawnToPawnTrade,
  spawnPackBeast,
  spawnOutdoorItem,
  getOutdoorItems,
  tickOutdoorItemWeathering,
  isStrangerPawn,
  MAX_SOCIAL_SLOT,
} from '../sim';
import { ModRegistry } from '../mods';

describe('RimWorld 进阶机制全量验收 (Power Grid, Fog of War, 13x13 Room, 3+3+3+3 Social, Anatomy/Fingers/Fertility, Trade, Slopes, Player-Only Build)', () => {
  it('1. 电网规模损耗与超限 0W 锁定：节点或跨度增大产生损耗，超出上限直接拒绝计算（功率锁定为 0W）', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), pawnCount: 2, playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 500;
    sim.stockpile['ore'] = 500;

    // 建造小型电网：1 座燃木发电机 (+1000W) + 1 座电灯塔 (-250W)
    const gen = placeArchitectBuilding(sim, 'wood_generator', 2, 2, 0, 'p_local_1');
    const tower = placeArchitectBuilding(sim, 'electric_beacon_tower', 4, 2, 0, 'p_local_1');
    expect(gen.ok).toBe(true);
    expect(tower.ok).toBe(true);

    const smallGrid = getBuildingPowerGrid(sim.world, gen.building!.id)!;
    expect(smallGrid).toBeDefined();
    expect(smallGrid.overloadRefused).toBe(false);
    expect(smallGrid.rawSupplyW).toBe(1000);
    expect(smallGrid.effectiveSupplyW).toBeGreaterThan(600);
    expect(smallGrid.netPowerW).toBeGreaterThan(0);

    // 铺设过长电缆使电网跨度超过 MAX_POWER_GRID_SPAN (36) 或节点数超过 MAX_POWER_GRID_NODES (32)
    for (let i = 0; i < 38; i++) {
      sim.world.addArchitectBuilding('power_conduit', 6 + i, 2, { allowContiguous: true, ignoreTerrain: true });
    }
    const overloadedGrids = evaluatePowerGrids(sim.world);
    const mainGrid = overloadedGrids.find((g) => g.buildingIds.includes(gen.building!.id))!;
    expect(mainGrid.spanTiles).toBeGreaterThan(MAX_POWER_GRID_SPAN);
    expect(mainGrid.overloadRefused).toBe(true);
    expect(mainGrid.effectiveSupplyW).toBe(0);
    expect(mainGrid.netPowerW).toBe(0);
  });

  it('2. 战争迷雾：跟随 Player 独立不共享，大篝火与通电电灯塔驱散迷雾，寻路自动截断至迷雾范围', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), pawnCount: 1, playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    sim.stockpile['wood'] = 200;
    sim.stockpile['stone'] = 200;
    sim.stockpile['ore'] = 200;

    // 殖民地原点在 Player 1 视野内，但对 Player 2 (无视野源在该处) 不可见
    expect(isTileVisibleToPlayer(sim, 'p_local_1', 0, 0)).toBe(true);
    expect(isTileVisibleToPlayer(sim, 'p_raider_2', 0, 0)).toBe(false);
    expect(MAX_ZOOM_FOG_RADIUS).toBe(28);

    // 距离原点 42 格处默认处于战争迷雾中
    expect(isTileVisibleToPlayer(sim, 'p_local_1', 0, 34)).toBe(false);

    // 寻路去迷雾深处 (50, 0) 会被截断在迷雾边界以内
    const rawPath = Array.from({ length: 50 }, (_, i) => ({ x: i + 1, y: 0 }));
    const clampedBefore = clampPathToPlayerFog(sim, 'p_local_1', rawPath);
    expect(clampedBefore.length).toBeLessThan(rawPath.length);

    // 玩家建造 2×2 驱雾大篝火 (great_bonfire) 在 (24, 0)，驱散半径 22 格，使 (30, 0) 变为可见！
    const bonfire = placeArchitectBuilding(sim, 'great_bonfire', 4, 0, 0, 'p_local_1');
    bonfire.building!.pos = { x: 0, y: 33 };
    expect(bonfire.ok).toBe(true);
    expect(isTileVisibleToPlayer(sim, 'p_local_1', 0, 34)).toBe(true);
    // 不同玩家不共享该大篝火视野
    expect(isTileVisibleToPlayer(sim, 'p_raider_2', 0, 34)).toBe(false);

    const sources = getPlayerFogSources(sim, 'p_local_1');
    expect(sources.some((s) => s.sourceKind === 'great_bonfire')).toBe(true);
  });

  it('3. 房间封顶规则：≤13×13 封闭房间正常封顶算室内，大于 13×13 的房间无法封顶算作室外', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), pawnCount: 0, playerRimWorldMode: true });

    // 建造一个 5×5 内部空间的封闭小房间 (外墙 7×7: x=-3..3, y=-3..3)
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        if (x === -3 || x === 3 || y === -3 || y === 3) {
          sim.world.addArchitectBuilding('wall', x, y, { allowContiguous: true, ignoreTerrain: true });
        }
      }
    }
    const smallRoom = inspectRoomAt(sim.world, 0, 0);
    expect(smallRoom.enclosed).toBe(true);
    expect(smallRoom.width).toBe(5);
    expect(smallRoom.height).toBe(5);
    expect(smallRoom.roofed).toBe(true);
    expect(smallRoom.indoors).toBe(true);

    // 建造一个 14×14 内部空间的超大封闭房间 (外墙 16×16: x=20..35, y=20..35)
    for (let x = -18; x <= -1; x++) {
      for (let y = -18; y <= -1; y++) {
        if (x === -18 || x === -1 || y === -18 || y === -1) {
          sim.world.addArchitectBuilding('wall', x, y, { allowContiguous: true, ignoreTerrain: true });
        }
      }
    }
    const hugeRoom = inspectRoomAt(sim.world, -5, -5);
    expect(hugeRoom.enclosed).toBe(true);
    expect(hugeRoom.width).toBeGreaterThanOrEqual(14);
    expect(hugeRoom.width).toBeGreaterThan(MAX_ROOM_SIDE);
    // 大于 13×13 的房间无法封顶，算作室外！
    expect(hugeRoom.roofed).toBe(false);
    expect(hugeRoom.indoors).toBe(false);
  });

  it('4. 社交 3+3+3+3 记忆上限：只记录最好 3 人、最差 3 人、最好 3 派系、最差 3 派系，其余作为临时数据', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), pawnCount: 6, playerRimWorldMode: true });
    const pawns = [...sim.pawns()];
    const hero = pawns[0];

    // 与 9 个其他小人建立正负关系（5 个正关系，4 个负关系）
    const deltas = [80, 60, 45, 25, 10, -15, -35, -55, -90];
    for (let i = 0; i < deltas.length; i++) {
      sim.addRelation(hero.eid, pawns[i + 1].eid, deltas[i]);
    }

    const summary = getBoundedSocialSummary(sim, hero.eid);
    expect(summary.bestRelations.length).toBeLessThanOrEqual(MAX_SOCIAL_SLOT);
    expect(summary.worstRelations.length).toBeLessThanOrEqual(MAX_SOCIAL_SLOT);
    expect(summary.bestFactions.length).toBeLessThanOrEqual(MAX_SOCIAL_SLOT);
    expect(summary.worstFactions.length).toBeLessThanOrEqual(MAX_SOCIAL_SLOT);
    expect(summary.bestRelations.map((r) => r.affinity)).toEqual([80, 60, 45]);
    expect(summary.worstRelations.map((r) => r.affinity)).toEqual([-90, -55, -35]);
    expect(summary.discardedTempRelationsCount).toBe(3); // 25, 10, -15 三条临时数据被过滤
  });

  it('5. 逐根手指(10根) / 内脏 / 头颅 / 四肢 / 生殖能力 独立建模与草药包扎、截肢、器官移植', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), pawnCount: 1, playerRimWorldMode: true });
    sim.stockpile['herb'] = 10;
    const p = [...sim.pawns()][0];
    ensurePawnAnatomy(p);

    // 验证 10 根手指、核心内脏、头颅五官、四肢、生殖系统全部独立存在
    const fingerParts = BODY_PART_DEFS.filter((d) => d.group === 'fingers');
    expect(fingerParts.length).toBe(10);
    expect(p.anatomy!['left_thumb']).toBeDefined();
    expect(p.anatomy!['right_pinky']).toBeDefined();
    expect(p.anatomy!['heart']).toBeDefined();
    expect(p.anatomy!['reproductive_organ']).toBeDefined();

    const initCaps = computeAnatomyCapacities(p);
    expect(initCaps.fertilityPct).toBe(100);
    expect(initCaps.manipulationPct).toBe(100);

    // 创伤左食指与生殖系统
    inflictBodyPartInjury(p, 'left_index', 6, 'cut', '割伤左食指');
    inflictBodyPartInjury(p, 'reproductive_organ', 10, 'bruise', '重创生殖系统');
    const woundedCaps = computeAnatomyCapacities(p);
    expect(woundedCaps.manipulationPct).toBeLessThan(100);
    expect(woundedCaps.fertilityPct).toBeLessThan(100);

    // 草药包扎左食指
    const bandRes = bandageBodyPartWithHerb(sim, p.eid, 'left_index');
    expect(bandRes.ok).toBe(true);
    expect(p.anatomy!['left_index'].status).toBe('bandaged');
    expect(p.anatomy!['left_index'].bleeding).toBe(false);

    // 截肢切除左小指
    const ampRes = amputateBodyPart(sim, p.eid, 'left_pinky');
    expect(ampRes.ok).toBe(true);
    expect(p.anatomy!['left_pinky'].status).toBe('amputated');
    expect(p.anatomy!['left_pinky'].hp).toBe(0);

    // 移植强化生殖系统与仿生手
    const transRes = transplantBodyPart(sim, p.eid, 'reproductive_organ', true);
    expect(transRes.ok).toBe(true);
    expect(computeAnatomyCapacities(p).fertilityPct).toBeGreaterThanOrEqual(100);
  });

  it('6. 任意小人之间交易（仅计入架子与 ≤13×13 室内储藏室财产 + 小人随身 + 驼兽随身）及野外加速风化、死亡不掉落', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), pawnCount: 2, playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');
    const [pawnA, pawnB] = [...sim.pawns()];
    pawnA.inventory = { wood: 5, food: 2 };
    pawnB.inventory = { wood: 1, food: 8 };
    pawnB.isStranger = true;

    // 陌生人隐私检查
    expect(isStrangerPawn(pawnB, 'p_local_1')).toBe(true);
    expect(isStrangerPawn(pawnA, 'p_local_1')).toBe(false);

    // 殖民地全局库存有 100 木材，但若未建储物架(shelf)且无 ≤13×13 封顶储藏室，地图库存不计入可交易财产！
    sim.stockpile['wood'] = 100;
    const propWithoutShelf = getTradeablePropertyForPawn(sim, pawnA.eid);
    expect(propWithoutShelf.shelfAndStorageRoomItems['wood'] ?? 0).toBe(0);
    expect(propWithoutShelf.totalTradeable['wood']).toBe(5); // 仅算小人随身的 5 木材

    // 建造一座双格储物架 (shelf) 并召唤一头携带 10 木材的驼兽
    placeArchitectBuilding(sim, 'shelf', 2, 0, 0, 'p_local_1');
    spawnPackBeast(sim, 'p_local_1', 3, 0, { wood: 10, gold: 4 });

    const propWithShelfAndBeast = getTradeablePropertyForPawn(sim, pawnA.eid);
    expect(propWithShelfAndBeast.shelfAndStorageRoomItems['wood']).toBeGreaterThan(0);
    expect(propWithShelfAndBeast.packBeastItems['wood']).toBe(10);
    expect(propWithShelfAndBeast.totalTradeable['wood']).toBeGreaterThanOrEqual(15);

    // 执行 pawnA 与陌生人 pawnB 之间的交易
    const tradeRes = executePawnToPawnTrade(sim, pawnA.eid, pawnB.eid, 'wood', 4, 'food', 3);
    expect(tradeRes.ok).toBe(true);
    expect(pawnA.inventory['food']).toBe(5);

    // 野外散落物加速风化测试
    spawnOutdoorItem(sim, 'food', 5, 10, 10);
    expect(getOutdoorItems(sim).length).toBe(1);
    tickOutdoorItemWeathering(sim, 30); // 30s * 4.5 HP/s > 100 HP -> 完全风化销毁
    expect(getOutdoorItems(sim).length).toBe(0);

    // 死亡不掉落测试：武器与身上物品保留在遗体上，地面不产生散落物
    sim.killPawn(pawnA.eid, '测试阵亡');
    const corpse = sim.deadPawnMap.get(pawnA.eid)!;
    expect(corpse).toBeDefined();
    expect(corpse.retainedOnCorpse).toBe(true);
    expect(corpse.equipWeapon).toBeDefined();
    expect(corpse.inventory?.['food']).toBe(5);
    expect(getOutdoorItems(sim).length).toBe(0);
  });

  it('7. 山体禁穿与禁透视、高差斜坡限制、征召攀爬/跳下检定以及建筑物规划 100% 交给玩家', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default(), pawnCount: 2, playerRimWorldMode: true });
    sim.enableRimWorldPlayerRules('p_local_1');

    // 验证开启 playerRimWorldMode 后，卡池中不含任何自主建造卡（建筑物规划 100% 交给玩家）
    const activeCards = sim.cards();
    expect(activeCards.some((c) => c.series === 'build' || c.id.startsWith('build_'))).toBe(false);

    // 验证斜坡占据的位置不能建造其他建筑
    sim.stockpile['wood'] = 100;
    sim.stockpile['stone'] = 100;
    const slopeBuilt = placeArchitectBuilding(sim, 'slope', 1, 1, 0, 'p_local_1');
    expect(slopeBuilt.ok).toBe(true);
    const tryWallOnSlope = inspectFootprintCells(sim, 'wall', 1, 1, 0);
    expect(tryWallOnSlope.valid).toBe(false);
    expect(tryWallOnSlope.reason).toContain('斜坡');

    // 查找一处高差邻格验证：非征召状态无斜坡不可跨越，征召状态可强行攀爬跳下（耗时 ×2.5 且带攀爬检定）
    let foundStep = false;
    for (let y = -20; y <= 20 && !foundStep; y++) {
      for (let x = -20; x <= 20 && !foundStep; x++) {
        if (isSolidMountainAt(sim.world, x, y) || isSolidMountainAt(sim.world, x + 1, y)) continue;
        const z1 = sim.world.zAt(x, y);
        const z2 = sim.world.zAt(x + 1, y);
        if (Math.abs(z1 - z2) === 1 && !canTraverseElevationWithSlope(sim.world, x, y, x + 1, y, false).allowed) {
          foundStep = true;
          const undraftedTrav = canTraverseElevationWithSlope(sim.world, x, y, x + 1, y, false);
          expect(undraftedTrav.allowed).toBe(false);
          const draftedTrav = canTraverseElevationWithSlope(sim.world, x, y, x + 1, y, true);
          expect(draftedTrav.allowed).toBe(true);
          expect(draftedTrav.speedPenaltyMul).toBeGreaterThanOrEqual(2.5);
          expect(draftedTrav.requiresClimbRoll).toBe(true);
        }
      }
    }
    expect(foundStep).toBe(true);

    // 验证厚重山体 (z>=3 stone) 阻断视线与通行
    let foundMtn = false;
    for (let y = -35; y <= 35 && !foundMtn; y++) {
      for (let x = -35; x <= 35 && !foundMtn; x++) {
        if (isSolidMountainAt(sim.world, x, y)) {
          foundMtn = true;
          expect(sim.passable(x, y)).toBe(false);
          expect(hasLineOfSight(sim.world, x - 2, y, x + 2, y)).toBe(false);
        }
      }
    }
    expect(foundMtn).toBe(true);
  });
});
