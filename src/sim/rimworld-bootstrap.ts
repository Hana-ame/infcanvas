/**
 * sim/rimworld-bootstrap.ts —— 本地模式测试 preset（bootstrapLocalRimWorldPreset）。
 *
 * 用途：把 client/main.ts 里那段「本地模式开局套件」（RimWorld 玩家规则 + stockpile
 * 加成 + 6×5 工坊房间 + 敌人/尸体 + 陌生鼠）抽成一个**具名的、可复用的 preset**，
 * 让测试、未来入口（例如 headless benchmark）能拿到**与本地模式逐字节等价**的开局，
 * 而不用复制粘贴那段 50 行代码。
 *
 * 为什么放在 sim/ 而不是 client/：这段 preset 描述的是「一局 RimWorld 风格的开局」，
 * 与渲染、UI、网络都无关。放在 sim/ 里让 server / 测试也能直接引用，不用为了
 * 引入它而把 client/* 拖进来（client/ 里有 pixi.js、ws 全局构造器等浏览器/服务端
 * 才有的依赖）。
 *
 * 「其他要保持全部一致」的硬约束：本函数产生的 sim 状态与 main.ts 原版开局**逐字节
 * 等价**（同 seed / 同 registry 下）。任何行为差异（比如漏掉一处 placeArchitectBuilding、
 * 改了一个坐标、换了名字）都会让本地模式开局体验变化——这是不允许的。测试在
 * src/__tests__/rimworld-bootstrap.test.ts 里锁死关键不变量。
 *
 * 调用前置条件：sim 应当是一个**全新**的 Sim 实例（未 step 过），且构造时**已**设
 * `playerRimWorldMode: true`（本 preset 会再调 `enableRimWorldPlayerRules` 兜底设置
 * activePlayerId + 建筑注册，但构造函数里的 `playerRimWorldMode` 影响 constructor
 * 末段的 `enforceSingleTileOccupancy`，两者不能省一个）。读档续跑场景**不要**调本
 * preset——存档里已经存了开局状态，再调一次会重复生成敌人/建筑。
 *
 * 幂等性：本函数**不**幂等。重复调用会重复生成敌人、重复建造（`placeArchitectBuilding`
 * 有 `allowReplace` 但 `spawnPackBeast` 是追加语义）。设计上是"每个 sim 只调一次"。
 */
import type { Sim } from './sim';
import { enforceSingleTileOccupancy, spawnCreatureCorpse } from './rimworld-ecology-butcher';
import { getRuinSites } from './mmo-ruins';
import { placeArchitectBuilding } from './rimworld-work';
import { spawnAncientDangerShrine, spawnBattlefieldCorpse } from './corpse-youtube-play';
import { spawnPackBeast } from './social-trade-weathering';
import { isRuinScavengeDlcEnabled } from '../mods/dlc-entry';

export interface LocalRimWorldPresetOpts {
  /** 玩家 id。默认 'p_local_1'，与 main.ts 原版一致。 */
  playerId?: string;
}

/**
 * 对已构造（且 `playerRimWorldMode: true`）的 sim 应用本地模式开局套件。
 *
 * 逐行对应 client/main.ts 134-184 的原版代码。抽出来后 main.ts 只调这一行，
 * 测试与未来入口直接复用。
 */
export function bootstrapLocalRimWorldPreset(
  sim: Sim,
  opts: LocalRimWorldPresetOpts = {},
): void {
  const playerId = opts.playerId ?? 'p_local_1';

  sim.enableRimWorldPlayerRules(playerId);

  sim.stockpile['wood'] = Math.max(sim.stockpile['wood'] ?? 0, 60);
  sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 32;
  sim.stockpile['stone'] = (sim.stockpile['stone'] ?? 0) + 24;
  sim.stockpile['gold'] = (sim.stockpile['gold'] ?? 0) + 8;
  sim.stockpile['herb'] = (sim.stockpile['herb'] ?? 0) + 12;

  // 初始化远古遗迹房间与内部可搜刮建筑（远古储物柜、军用物资箱、实验终端、休眠舱）
  if (isRuinScavengeDlcEnabled(sim)) getRuinSites(sim);

  // 开局建造一座 6×5 封闭室内工坊与厨房房间 (x=-6..-1, y=-7..-3)，供玩家直接点击房间体验「选中房间布置内设/装饰/工作台」
  for (let rx = -6; rx <= -1; rx++) {
    for (let ry = -7; ry <= -3; ry++) {
      const isEdge = rx === -6 || rx === -1 || ry === -7 || ry === -3;
      if (!isEdge) continue;
      const isDoor = rx === -3 && ry === -3;
      const b = sim.world.addArchitectBuilding(isDoor ? 'door' : 'wall', rx, ry, {
        allowContiguous: true,
        ignoreTerrain: true,
        allowReplace: true,
      });
      if (b) b.ownerPlayerId = playerId;
    }
  }
  placeArchitectBuilding(sim, 'stove', -5, -6, 0, playerId);
  placeArchitectBuilding(sim, 'butcher_table', -3, -6, 0, playerId);
  placeArchitectBuilding(sim, 'shelf', -5, -4, 0, playerId);
  placeArchitectBuilding(sim, 'great_bonfire', 3, -3, 0, playerId);
  spawnAncientDangerShrine(sim, -8, -5);
  spawnPackBeast(sim, playerId, 3, 2, { food: 10, wood: 12, ore: 6, herb: 4 });
  spawnBattlefieldCorpse(sim, 5, -2, {
    name: '赤爪先锋斥候遗体 (可搜尸/屠宰)',
    equipWeapon: '精准栓动步枪 (Bolt-Action Rifle)',
    equipApparel: '掠夺者防弹背心 (Flak Vest)',
    inventory: { ore: 6, gold: 3, herb: 2, meal: 2 },
    butcherYield: { meat: 3, leather: 2 },
    causeOfDeath: '前哨交火阵亡',
  });
  spawnCreatureCorpse(sim, 'deer', -4, 2);

  const strangerEid = sim.spawnPawn(6, -3);
  const stranger = sim.pawn(strangerEid);
  if (stranger) {
    stranger.name = '旅鼠·墨菲(陌生人)';
    stranger.isStranger = true;
    stranger.controlledBy = 'p_stranger_faction';
    stranger.inventory = { food: 15, herb: 6, gold: 4, wood: 10 };
  }

  enforceSingleTileOccupancy(sim);
}
