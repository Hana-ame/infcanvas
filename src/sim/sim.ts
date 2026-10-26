/**
 * sim.ts —— 权威模拟本体：实体管理 + 空间哈希网格 + 单格唯一对象 + 生物尸体拖回屠宰 + 蓝图自动施工 + 植物蔓延 + 小人精神崩溃离开派系自主求生 + AImode DLC 门控。
 */
import { mulberry32, type RngFn } from './rng';
import { type Tuning } from './tuning';
import { World } from './world';
import { RoutePlanner } from './path-plan';
import { InfiniteChunkPathfinder } from './hpa-infinite';
import { initPawnRimWorldProfile } from './genetics-skills';
import { ensurePawnTriads } from './triad-specialization';
import { tickPawnBookkeeping } from './pawn-bookkeeping';
import { SpatialHashGrid } from './spatial-grid';
import { ensureRimWorldBuildingsRegistered, tickRimWorldBlueprintWork } from './rimworld-work';
import { isSolidMountainAt, canStepElevationFast, canTraverseElevationWithSlope, clampPathToPlayerFog, hasSlopeAt, SLOPE_LADDER_SPEED_PENALTY_MUL, } from './rooms-power-fog';
import { computeAnatomyCapacities, inflictBodyPartInjury } from './anatomy-health';
import { spawnBattlefieldCorpse } from './corpse-youtube-play';
import { tickOutdoorItemWeathering } from './social-trade-weathering';
import { enforceSingleTileOccupancy, findNearestUnoccupiedTile, spawnCreatureCorpse, tickPlantSpread, tickRimWorldButcherHaul, } from './rimworld-ecology-butcher';
import { assignPawnToGroup, getColonistGroups, refreshGroupCarryMetrics, tickRimWorldScavengeOrders } from './mmo-groups-ruins';
import { ensureInitialCulinaryStockpile, getActiveCulinaryBuff } from './culinary-dishes';
import { terrainMetaAt } from './terrain';
import { getActiveSimDlcs, isAiModeDlcEnabled } from '../mods/dlc-entry';
import { dispatchSimCommand, executeChooseDialogueOption, executeSimInteract } from './sim-commands';
import type { SimContext, CardWeightHook } from './context';
import type { CardDef } from './cards';
import { commit, releaseHerbReservation, tryReserveHerb, type GameSystem } from './systems';
import type {
  BuildingState,
  DialogueState,
  Eid,
  FeatureHit,
  Hostile,
  InteractOutcome,
  LogEvent,
  PawnState,
  Pos,
} from './types';
import type { SaveData } from './schema';
import type { ModRegistry } from '../mods/registry';
function clampTileEdge(v: number, dir: number): number {
  const c = Math.round(v);
  return dir > 0 ? c + 0.5 - 0.01 : c - 0.5 + 0.01;
}
export interface SimConfig {
  seed?: number;
  pawnCount?: number;
  registry: ModRegistry;
  restore?: SaveData;
  playerRimWorldMode?: boolean;
}
export class Sim implements SimContext {
  readonly world: World;
  readonly planner: RoutePlanner;
  readonly infinitePathfinder: InfiniteChunkPathfinder;
  readonly pawnGrid = new SpatialHashGrid<PawnState>(8);
  readonly hostileGrid = new SpatialHashGrid<Hostile>(8);
  readonly reg: ModRegistry;
  tuning: Tuning;
  time = 0;
  systems: GameSystem[] = [];
  readonly pawnMap = new Map<Eid, PawnState>();
  readonly deadPawnMap = new Map<Eid, PawnState>();
  readonly hostilesList: Hostile[] = [];
  stockpile: Record<string, number> = {};
  events: LogEvent[] = [];
  selected: Eid[] = [];
  dialogue: DialogueState | null = null;
  readonly scratch: Record<string, number> = {};
  playerRimWorldMode = false;
  activePlayerId = 'p_local_1';
  private climbRolledTargetKey = new Map<Eid, string>();
  private unreachableGoalVer = -1;
  private unreachableGoals = new Set<number>();
  private techsUnlocked = new Set<string>();
  readonly techFragments: Record<string, number> = {};
  private rngImpl: RngFn;
  private nextEid = 1;
  private nextHostileId = 1;
  private relations = new Map<string, number>();
  constructor(cfg: SimConfig) {
    this.reg = cfg.registry;
    this.tuning = this.reg.effectiveTuning();
    ensureRimWorldBuildingsRegistered(this, Boolean(cfg.playerRimWorldMode));
    if (cfg.playerRimWorldMode) this.playerRimWorldMode = true;
    const seed = cfg.restore?.seed ?? cfg.seed ?? 20260821;
    this.rngImpl = mulberry32(seed);
    this.world = new World(this.tuning, seed, { x: 0, y: 0 });
    if (this.playerRimWorldMode) this.world.rimWorldSingleOccupancy = true;
    this.planner = new RoutePlanner(this.world);
    this.infinitePathfinder = new InfiniteChunkPathfinder(this.world);
    this.systems = this.reg.assemble(this);
    const restoring = cfg.restore !== undefined;
    if (!restoring) for (const s of this.systems) s.init?.();
    else this.applyRestore(cfg.restore!);
    if (cfg.pawnCount !== undefined && !restoring) {
      for (let i = 0; i < cfg.pawnCount; i++) this.spawnPawn();
    }
    if (this.playerRimWorldMode && !restoring) {
      enforceSingleTileOccupancy(this);
    }
    this.rebuildSpatialGrids();
  }
  rebuildSpatialGrids(): void {
    this.pawnGrid.rebuild(this.pawnMap.values());
    this.hostileGrid.rebuild(this.hostilesList);
  }
  enableRimWorldPlayerRules(activePlayerId = 'p_local_1'): void {
    this.playerRimWorldMode = true;
    this.activePlayerId = activePlayerId;
    this.world.rimWorldSingleOccupancy = true;
    ensureRimWorldBuildingsRegistered(this, true);
    ensureInitialCulinaryStockpile(this);
    enforceSingleTileOccupancy(this);
    this.planner.clearRoutes();
    if (!isAiModeDlcEnabled(this)) {
      for (const p of this.pawnMap.values()) {
        if (p.cardId && (p.cardId.startsWith('build_') || p.cardId === 'till_field')) {
          p.cardId = null;
          p.busyUntil = this.time;
        }
      }
    }
  }
  rng(): number {
    return this.rngImpl();
  }
  pawns(): IterableIterator<PawnState> {
    return this.pawnMap.values();
  }
  pawn(eid: Eid): PawnState | undefined {
    return this.pawnMap.get(eid);
  }
  spawnPawn(x?: number, y?: number): Eid {
    const eid = this.nextEid++;
    const pos = x !== undefined && y !== undefined ? { x, y } : this.findSpawn();
    const traitIds = Object.keys(this.tuning.traits);
    const p: PawnState = {
      eid,
      name: `鼠${eid}`,
      pos,
      needs: { food: 90, rest: 90, mood: 70, san: 90 },
      hp: this.tuning.pawn.hp,
      maxHp: this.tuning.pawn.hp,
      trait: traitIds[Math.floor(this.rng() * traitIds.length)],
      climb: this.tuning.pawn.climb,
      cardId: null,
      busyUntil: 0,
      holdUntil: 0,
      atkCd: 0,
      path: [],
      mastery: {},
      uses: {},
    };
    initPawnRimWorldProfile(p, this.world.seed);
    ensurePawnTriads(p, this.world.seed);
    this.pawnMap.set(eid, p);
    this.pawnGrid.insert(p);
    this.log(`🐭 ${p.name} 出生（${this.tuning.traits[p.trait].name}）`);
    return eid;
  }
  killPawn(eid: Eid, cause: string): void {
    const p = this.pawnMap.get(eid);
    if (!p) return;
    releaseHerbReservation(this, eid);
    delete this.scratch[`medicine.target.${eid}`];
    for (const [k, v] of Object.entries(this.scratch)) {
      if (v === eid && k.startsWith('medicine.target.')) delete this.scratch[k];
    }
    p.retainedOnCorpse = true;
    p.corpseLooted = false;
    p.corpseOrgansHarvested = false;
    p.corpseButchered = false;
    p.butcherYield = p.butcherYield ?? { meat: 3, leather: 2 };
    p.causeOfDeath = cause;
    p.deathTime = this.time;
    const corpseClone = structuredClone(p);
    if (this.playerRimWorldMode) {
      corpseClone.pos = findNearestUnoccupiedTile(this, p.pos.x, p.pos.y, {
        ignorePawnEid: eid,
        replaceSurfacePlant: true,
      });
    }
    this.deadPawnMap.set(eid, corpseClone);
    this.pawnMap.delete(eid);
    this.selected = this.selected.filter((s) => s !== eid);
    this.log(`💀 ${p.name} 死亡（${cause}）`);
  }
  private findSpawn(): Pos {
    const anchor = this.campPos() ?? this.world.spawn;
    for (let r = 0; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = anchor.x + dx;
          const cy = anchor.y + dy;
          if (!this.passable(cx, cy)) continue;
          if (this.playerRimWorldMode && this.world.buildingAt(cx, cy)) continue;
          return { x: cx, y: cy };
        }
      }
    }
    return { ...anchor };
  }
  campPos(): Pos | null {
    const c = this.meanPawnPos();
    const fire = this.world.nearestBuildingByTag('fire', c.x, c.y);
    return fire ? fire.pos : null;
  }
  private meanPawnPos(): Pos {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of this.pawnMap.values()) {
      sx += p.pos.x;
      sy += p.pos.y;
      n++;
    }
    return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
  }
  hostiles(): readonly Hostile[] {
    return this.hostilesList;
  }
  spawnHostile(kind: string, x: number, y: number): Hostile {
    const def = this.tuning.enemies[kind];
    if (!def) throw new Error(`spawnHostile：未注册的敌人类别「${kind}」（缺挂载注册它的玩法包）`);
    const h: Hostile = {
      id: this.nextHostileId++,
      kind,
      pos: { x, y },
      hp: def.hp,
      maxHp: def.hp,
      atkCd: def.atkCd,
    };
    this.hostilesList.push(h);
    this.hostileGrid.insert(h);
    this.log(`${def.name} 出没！`);
    return h;
  }
  despawnHostile(id: number): void {
    const i = this.hostilesList.findIndex((h) => h.id === id);
    if (i >= 0) this.hostilesList.splice(i, 1);
  }
  damagePawn(eid: Eid, dmg: number, cause: string): void {
    const p = this.pawnMap.get(eid);
    if (!p) return;
    p.hp -= dmg;
    if (p.hp <= 0) this.killPawn(eid, cause);
  }
  damageHostile(id: number, dmg: number): void {
    const h = this.hostilesList.find((x) => x.id === id);
    if (!h) return;
    h.hp -= dmg;
    if (h.hp <= 0) {
      const def = this.tuning.enemies[h.kind];
      const isRaiderOrMech = h.kind.startsWith('raider') || h.kind === 'siege_rat_mech';
      if (this.playerRimWorldMode) {
        if (isRaiderOrMech) {
          const drops = def?.drops ?? {};
          for (const [k, v] of Object.entries(drops)) {
            this.stockpile[k] = (this.stockpile[k] ?? 0) + v;
          }
          const freePos = findNearestUnoccupiedTile(this, h.pos.x, h.pos.y, {
            ignoreHostileId: h.id,
            replaceSurfacePlant: true,
          });
          spawnBattlefieldCorpse(this, freePos.x, freePos.y, {
            eid: 20000 + h.id,
            name: `${def?.name ?? h.kind} 遗体 (#${h.id})`,
            equipWeapon: h.kind.includes('sniper') ? '赤爪狙击弩' : '制式突击步枪',
            equipApparel: '掠夺者防弹背心',
            inventory: { ore: 3, gold: 2, herb: 1, meal: 1 },
            butcherYield: { meat: 3, leather: 2 },
            causeOfDeath: '被殖民地防线击毙',
            isRaiderCorpse: true,
          });
          this.despawnHostile(id);
          this.log(`💀 ${def?.name ?? h.kind} 被击毙，留下了一具可搜刮/屠宰的遗体`);
          return;
        }
        const corpse = spawnCreatureCorpse(this, h);
        this.despawnHostile(id);
        this.log(`💀 ${def?.name ?? h.kind} 死亡，留下了【${corpse.name}】（需拖回屠宰台屠宰获取肉与毛皮）`);
        return;
      }
      const drops = def?.drops ?? {};
      const dropTxt = Object.entries(drops)
        .map(([k, v]) => `+${v} ${k}`)
        .join(' ');
      for (const [k, v] of Object.entries(drops)) {
        this.stockpile[k] = (this.stockpile[k] ?? 0) + v;
      }
      this.despawnHostile(id);
      this.log(dropTxt ? `${def?.name ?? h.kind} 被击退了（${dropTxt}）` : `${def?.name ?? h.kind} 被击退了`);
    }
  }
  passable(x: number, y: number): boolean {
    if (this.playerRimWorldMode && isSolidMountainAt(this.world, x, y)) return false;
    return this.world.canStand(x, y);
  }
  zAt(x: number, y: number): number {
    return this.world.zAt(x, y);
  }
  canStep(fx: number, fy: number, tx: number, ty: number, climb: number): boolean {
    if (this.playerRimWorldMode) {
      if (!this.passable(tx, ty)) return false;
      return canStepElevationFast(this.world, fx, fy, tx, ty, climb > 1);
    }
    return this.world.canStep(fx, fy, tx, ty, climb);
  }
  featureAt(x: number, y: number): FeatureHit | null {
    return this.world.featureAt(x, y);
  }
  nearestFeature(kind: FeatureHit['kind'], x: number, y: number, maxR: number): FeatureHit | null {
    return this.world.nearestFeature(kind, x, y, maxR);
  }
  takeOne(x: number, y: number): number {
    return this.world.takeOne(x, y);
  }
  featureRect(f: FeatureHit): { x0: number; y0: number; x1: number; y1: number } {
    return this.world.featureRect(f);
  }
  distToFeatureRect(px: number, py: number, r: { x0: number; y0: number; x1: number; y1: number }): number {
    return this.world.distToFeatureRect(px, py, r);
  }
  nearestFreeAdjacent(rect: { x0: number; y0: number; x1: number; y1: number }, fx: number, fy: number): Pos | null {
    return this.world.nearestFreeAdjacent(rect, fx, fy);
  }
  nearestBuildingByTag(tag: string, x: number, y: number, maxR = Infinity): BuildingState | undefined {
    return this.world.nearestBuildingByTag(tag, x, y, maxR);
  }
  buildingsAll(): Iterable<BuildingState> {
    return this.world.buildings.values();
  }
  addBuilding(defId: string, x: number, y: number): BuildingState | null {
    if (this.playerRimWorldMode && !isAiModeDlcEnabled(this) && this.time > 0) return null;
    this.planner.clearRoutes();
    this.infinitePathfinder.invalidateAtTile(x, y);
    return this.world.addBuilding(defId, x, y);
  }
  removeBuilding(id: string): void {
    const b = this.world.buildings.get(id);
    if (b) this.infinitePathfinder.invalidateAtTile(b.pos.x, b.pos.y);
    this.planner.clearRoutes();
    this.world.removeBuilding(id);
  }
  techUnlocked(): ReadonlySet<string> {
    return this.techsUnlocked;
  }
  techOrder(): readonly string[] {
    return this.reg.techOrder();
  }
  techFragmentsOf(techId: string): number {
    return this.techFragments[techId] ?? 0;
  }
  grantTechFragment(techId: string): 'unlocked' | 'progress' | 'dup' | 'unknown' {
    const def = this.tuning.techs[techId];
    if (!def) return 'unknown';
    if (this.techsUnlocked.has(techId)) return 'dup';
    const next = (this.techFragments[techId] ?? 0) + 1;
    this.techFragments[techId] = next;
    if (next < def.fragments) return 'progress';
    this.techFragments[techId] = 0;
    this.techsUnlocked.add(techId);
    this.log(`🔬 科技解锁：${def.name}`);
    return 'unlocked';
  }
  techSatisfied(tech: readonly string[] | undefined): boolean {
    if (!tech || tech.length === 0) return true;
    for (const id of tech) {
      if (this.tuning.techs[id] !== undefined && !this.techsUnlocked.has(id)) return false;
    }
    return true;
  }
  hasDlc(id: string): boolean {
    const active = getActiveSimDlcs(this);
    if (id === 'ai_mode' || id === 'aimode' || id === 'dlc-ai-mode') {
      return active.has('dlc-ai-director') || this.reg.dlcEnabled('dlc-ai-director');
    }
    return this.reg.dlcEnabled(id) || active.has(id);
  }
  relation(a: Eid, b: Eid): number {
    return this.relations.get(pairKey(a, b)) ?? 0;
  }
  addRelation(a: Eid, b: Eid, delta: number): void {
    const k = pairKey(a, b);
    const v = Math.max(-100, Math.min(100, (this.relations.get(k) ?? 0) + delta));
    this.relations.set(k, v);
  }
  setPath(p: PawnState, txRaw: number, tyRaw: number): boolean {
    const tx = Math.round(txRaw);
    const ty = Math.round(tyRaw);
    const sx = Math.round(p.pos.x);
    const sy = Math.round(p.pos.y);
    if (this.playerRimWorldMode) {
      const playerId = p.controlledBy ?? this.activePlayerId;
      const drafted = Boolean(p.drafted);
      const tagVer = this.world.tagVersionNow();
      if (this.unreachableGoalVer !== tagVer) {
        this.unreachableGoalVer = tagVer;
        this.unreachableGoals.clear();
      }
      const goalKey = ((tx + 32768) * 65536 + (ty + 32768)) * 2 + (drafted ? 1 : 0);
      if (this.unreachableGoals.has(goalKey) && Math.abs(sx - tx) + Math.abs(sy - ty) > 6) {
        p.path = [];
        return false;
      }
      const rawPath = this.planner.plan({
        canStep: (fx, fy, ax, ay) => {
          if (!this.world.canStand(ax, ay) || isSolidMountainAt(this.world, ax, ay)) return false;
          return canStepElevationFast(this.world, fx, fy, ax, ay, drafted);
        },
        canStand: (ax, ay) => this.world.canStand(ax, ay) && !isSolidMountainAt(this.world, ax, ay),
        sx,
        sy,
        tx,
        ty,
      });
      if (rawPath.length === 0 && (sx !== tx || sy !== ty)) {
        this.unreachableGoals.add(goalKey);
      }
      const clamped = clampPathToPlayerFog(
        this,
        playerId,
        rawPath.length > 0 ? rawPath.slice() : rawPath,
      );
      p.path = clamped;
      return clamped.length > 0 || (sx === tx && sy === ty);
    }
    const path = this.planner.plan({
      canStep: (fx, fy, ax, ay) => this.world.canStep(fx, fy, ax, ay, p.climb),
      canStand: (ax, ay) => this.world.canStand(ax, ay),
      sx,
      sy,
      tx,
      ty,
    });
    p.path = path.length > 0 ? path.slice() : path;
    return path.length > 0 || (sx === tx && sy === ty);
  }
  moveStep(p: PawnState, dt: number): void {
    let speedMul = 1.0;
    if (this.playerRimWorldMode) {
      const caps = computeAnatomyCapacities(p);
      const tMeta = terrainMetaAt(this.world, p.pos.x, p.pos.y);
      const onLadder = hasSlopeAt(this.world, p.pos.x, p.pos.y);
      const ladderMul = onLadder ? 1 / SLOPE_LADDER_SPEED_PENALTY_MUL : 1.0;
      const cBuff = getActiveCulinaryBuff(p, this.time);
      const buffMoveMul = cBuff ? 1 + cBuff.moveSpeedPct / 100 : 1.0;
      speedMul =
        0.42 *
        Math.max(0.15, caps.movingPct / 100) *
        Math.max(0.3, tMeta.moveSpeedMul || 1) *
        ladderMul *
        buffMoveMul;
      if (p.inMeleeGrapple) speedMul *= 0.08;
    }
    let budget = this.tuning.pawn.speed * speedMul * dt;
    while (budget > 0 && p.path.length > 0) {
      const next = p.path[0];
      if (this.playerRimWorldMode) {
        if (isSolidMountainAt(this.world, next.x, next.y)) {
          p.path = [];
          break;
        }
        const trav = canTraverseElevationWithSlope(
          this.world,
          Math.round(p.pos.x),
          Math.round(p.pos.y),
          next.x,
          next.y,
          Boolean(p.drafted),
        );
        if (!trav.allowed) {
          p.path = [];
          break;
        }
        if (trav.viaSlope && trav.speedPenaltyMul > 1) {
          budget /= trav.speedPenaltyMul;
        } else if (trav.requiresClimbRoll) {
          budget /= trav.speedPenaltyMul;
          const stepKey = `${next.x},${next.y}`;
          if (this.climbRolledTargetKey.get(p.eid) !== stepKey) {
            this.climbRolledTargetKey.set(p.eid, stepKey);
            if (!this.rollSuccess(this.tuning.successRate.climb)) {
              const partId = this.rng() < 0.5 ? 'left_leg' : 'right_leg';
              inflictBodyPartInjury(p, partId, 6, 'bruise', '征召攀爬/跳下高差跌伤');
              this.log(`⚠ ${p.name} 在征召状态下强行攀爬/跳下高地失手跌伤（腿部挫伤 -6 HP）！`);
            }
          }
        }
      }
      const dx = next.x - p.pos.x;
      const dy = next.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        p.pos.x = next.x;
        p.pos.y = next.y;
        p.path.shift();
        budget -= d;
      } else {
        p.pos.x += (dx / d) * budget;
        p.pos.y += (dy / d) * budget;
        budget = 0;
      }
    }
  }
  adjacent(p: PawnState, x: number, y: number, r = 1.5): boolean {
    return Math.hypot(p.pos.x - x, p.pos.y - y) <= r;
  }
  moveDir(p: PawnState, dx: number, dy: number, dt: number): boolean {
    const slowMul = this.playerRimWorldMode ? 0.45 : 1.0;
    const step = this.tuning.hero.speed * slowMul * Math.min(dt, 0.25);
    let moved = false;
    if (dx !== 0) {
      const nx = p.pos.x + dx * step;
      if (this.canStep(p.pos.x, p.pos.y, nx, p.pos.y, p.drafted ? 2 : p.climb)) {
        p.pos.x = nx;
        moved = true;
      } else p.pos.x = clampTileEdge(p.pos.x, dx);
    }
    if (dy !== 0) {
      const ny = p.pos.y + dy * step;
      if (this.canStep(p.pos.x, p.pos.y, p.pos.x, ny, p.drafted ? 2 : p.climb)) {
        p.pos.y = ny;
        moved = true;
      } else p.pos.y = clampTileEdge(p.pos.y, dy);
    }
    return moved;
  }
  rollSuccess(rate: number): boolean {
    return this.rng() < rate;
  }
  directAttack(eid: Eid): boolean {
    const p = this.pawnMap.get(eid);
    if (!p || p.atkCd > 0) return false;
    const best = this.hostileGrid.nearestInRadius(p.pos.x, p.pos.y, this.tuning.hero.attackRange);
    if (!best) return false;
    p.atkCd = this.tuning.pawn.atkCd;
    p.path = [];
    p.attackWindup = 0;
    p.attackWindupTotal = 0.8;
    p.attackTargetId = best.id;
    const def = this.tuning.enemies[best.kind];
    const name = def ? def.name : best.kind;
    if (this.rollSuccess(this.tuning.successRate.attack)) {
      this.damageHostile(best.id, this.tuning.pawn.dmg);
      this.log(`⚔ ${p.name} 命中 ${name}`);
    } else {
      this.log(`⚔ ${p.name} 攻击 ${name} 落空`);
    }
    return true;
  }
  interact(eid: Eid): InteractOutcome | null {
    return executeSimInteract(this, eid);
  }
  openDialogue(npcEid: Eid): boolean {
    const npc = this.pawnMap.get(npcEid);
    if (!npc) return false;
    const wanted = npc.npc?.dialogueId ?? 'colony';
    const dialogueId = this.tuning.dialogues[wanted] ? wanted : 'colony';
    if (!this.tuning.dialogues[dialogueId]) return false;
    this.dialogue = { npcEid, dialogueId };
    return true;
  }
  chooseOption(i: number): 'applied' | 'rejected' | 'closed' | 'invalid' {
    return executeChooseDialogueOption(this, i);
  }
  closeDialogue(): void {
    this.dialogue = null;
  }
  cards(): readonly CardDef[] {
    if (this.playerRimWorldMode && !isAiModeDlcEnabled(this)) {
      return this.reg.cards.filter(
        (c) => c.series !== 'build' && !c.id.startsWith('build_') && c.id !== 'till_field',
      );
    }
    return this.reg.cards;
  }
  cardById(id: string): CardDef | undefined {
    if (this.playerRimWorldMode && !isAiModeDlcEnabled(this) && (id.startsWith('build_') || id === 'till_field')) {
      return undefined;
    }
    return this.reg.cardById(id);
  }
  weightHooks(): readonly CardWeightHook[] {
    return this.reg.weightHooks;
  }
  finishCard(p: PawnState): void {
    p.busyUntil = this.time;
  }
  log(text: string): void {
    this.events.push({ time: this.time, text });
    if (this.events.length > this.tuning.events.maxLog) {
      this.events.splice(0, this.events.length - this.tuning.events.maxLog);
    }
  }
  command(type: string, args: Record<string, unknown> = {}): void {
    this.issueCommand(type, args, 'system');
  }
  issueCommand(type: string, args: Record<string, unknown> = {}, source: 'player' | 'system' = 'player'): void {
    dispatchSimCommand(this, type, args, source);
  }
  /** 全局环境结算链：跨包 tick（风化/蔓延/屠宰搬运/蓝图施工/捡拾指令）。
   *  原先在 step() 与 stepChunked() 里各硬编码一份，已收敛为单一实现。 */
  private tickWorldHooks(dt: number): void {
    tickOutdoorItemWeathering(this, dt);
    tickPlantSpread(this, dt);
    tickRimWorldButcherHaul(this, dt);
    tickRimWorldBlueprintWork(this, dt);
    tickRimWorldScavengeOrders(this, dt);
  }
  step(dt: number): void {
    this.time += dt;
    this.world.now = this.time;
    this.rebuildSpatialGrids();
    tickPawnBookkeeping(this, dt);
    this.tickWorldHooks(dt);
    for (const sys of this.systems) sys.update?.(dt);
  }
  stepChunked(dt: number, activeChunks: ReadonlySet<number> | null): void {
    this.time += dt;
    this.world.now = this.time;
    this.rebuildSpatialGrids();
    tickPawnBookkeeping(this, dt);
    this.tickWorldHooks(dt);
    for (const sys of this.systems) {
      if (activeChunks === null) sys.update?.(dt);
      else if (sys.updateChunked) sys.updateChunked(dt, activeChunks);
      else sys.update?.(dt);
    }
  }
  run(seconds: number, dt = 1): void {
    for (let t = 0; t < seconds; t++) this.step(dt);
  }
  rngState(): number {
    return this.rngImpl.getState();
  }
  nextEidValue(): number {
    return this.nextEid;
  }
  nextHostileIdValue(): number {
    return this.nextHostileId;
  }
  exportRelations(): [string, number][] {
    return [...this.relations.entries()];
  }
  private applyRestore(d: SaveData): void {
    this.time = d.time;
    this.rngImpl.setState(d.rngState);
    this.nextEid = d.nextEid;
    this.nextHostileId = d.nextHostileId;
    this.pawnMap.clear();
    for (const p of d.pawns) this.pawnMap.set(p.eid, structuredClone(p));
    this.hostilesList.length = 0;
    this.hostilesList.push(...d.hostiles.map((h) => structuredClone(h)));
    this.stockpile = { ...d.stockpile };
    this.relations.clear();
    for (const [k, v] of d.relations) this.relations.set(k, v);
    this.events = structuredClone(d.events);
    Object.keys(this.scratch).forEach((k) => delete this.scratch[k]);
    Object.assign(this.scratch, d.scratch);
    this.techsUnlocked = new Set(d.techs ?? []);
    for (const k of Object.keys(this.techFragments)) delete this.techFragments[k];
    Object.assign(this.techFragments, d.techFragments ?? {});
    this.world.importState(d.world);
    this.world.now = d.time;
  }
  debugForceCard(eid: Eid, cardId: string): boolean {
    const card = this.reg.cardById(cardId);
    const p = this.pawnMap.get(eid);
    if (!card || !p) return false;
    releaseHerbReservation(this, p.eid);
    if (!tryReserveHerb(this, p, card)) return false;
    p.cardId = null;
    p.busyUntil = this.time;
    commit(this, p, card);
    return true;
  }
}
/**
 * RimWorld 精神崩溃：小人因极端压力放弃并离开殖民地派系（Run Wild / Give Up and Leave），
 * 在地图周围由 AI 行为系统自动管理自主生存（采野果、进食、露宿、漫步），玩家可驯服/重新招募。
 */
export function triggerColonistMentalBreak(
  sim: Sim,
  eid: Eid,
  reason = '精神崩溃',
): { ok: boolean; pawn?: PawnState; message: string } {
  const p = sim.pawn(eid);
  if (!p) return { ok: false, message: '未找到指定殖民者' };
  p.isStranger = true;
  p.formerColonist = true;
  p.mentalBreakState = 'wild_man';
  p.controlledBy = 'p_wild_faction';
  p.drafted = false;
  p.holdUntil = 0;
  p.busyUntil = sim.time;
  p.cardId = null;
  p.activeWork = undefined;
  p.groupId = undefined;
  p.needs.mood = Math.max(55, p.needs.mood);
  p.needs.san = Math.max(60, p.needs.san);
  sim.selected = sim.selected.filter((id) => id !== eid);
  refreshGroupCarryMetrics(sim);
  const wildTarget = findNearestUnoccupiedTile(sim, p.pos.x + 8, p.pos.y - 6, { ignorePawnEid: eid });
  sim.setPath(p, wildTarget.x, wildTarget.y);
  const msg = `🧠【精神崩溃：离开派系】${p.name} 因${reason}彻底崩溃，脱离殖民地派系在周边荒野独自求生（由 AI 接管，可右键重新招募）！`;
  sim.log(msg);
  return { ok: true, pawn: p, message: msg };
}
/** 重新安抚/招募因精神崩溃脱离派系的荒野前殖民者 */
export function recruitWildFormerColonist(
  sim: Sim,
  eid: Eid,
  targetGroupId = 'group_alpha',
): { ok: boolean; pawn?: PawnState; message: string } {
  const p = sim.pawn(eid);
  if (!p || !p.isStranger) return { ok: false, message: '目标并非脱离派系的荒野游民' };
  p.isStranger = false;
  p.formerColonist = false;
  p.mentalBreakState = undefined;
  p.controlledBy = sim.activePlayerId;
  p.needs.mood = Math.max(68, p.needs.mood);
  p.needs.san = Math.max(75, p.needs.san);
  const groups = getColonistGroups(sim);
  const grpId = groups.has(targetGroupId) ? targetGroupId : 'group_alpha';
  assignPawnToGroup(sim, p.eid, grpId);
  const msg = `🤝【重返殖民地】成功安抚并重新招募了 ${p.name}，已回归殖民地派系！`;
  sim.log(msg);
  return { ok: true, pawn: p, message: msg };
}
function pairKey(a: Eid, b: Eid): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}
