// 旧世界遗迹 DLC（2026-08-20，用户设计：生成废弃营地/教堂/古战场 → 探索发现 → 历史事实）
// 种子原则：不写任务系统/不写发现机制——在世界生成时按概率放置遗迹建筑
// （已损坏状态），小人走近时触发事件 → 写入篝火记忆 → 进入社交循环。
// 遗迹 = 生成时 hp=0（废墟）+ meta.ruin = { type, age, story }
// 小人走到遗迹旁 → bus.emit('ruin_discovered') → logEvent + addMemory
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { World } from '../../sim/core/world';

const CFG = {
  ruinSpawnChance: 0.02,  // 2% 的 chunk 生成遗迹
  discoverRange: 2,      // 小人走近 2 格内触发发现
  checkInterval: 5,      // 发现检查 5s 一次
};

const RUIN_TYPES = [
  { building: 'campfire', name: '废弃营地', stories: ['篝火早已熄灭', '营地空无一人', '灰烬中似有余温'] },
  { building: 'church', name: '荒废教堂', stories: ['教堂倾颓', '钟声不再', '神像蒙尘'] },
  { building: 'monument', name: '古战场遗迹', stories: ['曾在此激战', '箭矢散落', '英魂长眠'] },
  { building: 'wall', name: '断壁残垣', stories: ['城墙崩塌', '藤蔓缠绕', '岁月侵蚀'] },
] as const;

// 旧世界遗迹系统：世界生成时放置废墟建筑 → 小人走近发现 → 写入篝火记忆
// 5s 节流（发现检查不需要每帧），2 格内触发发现事件
// 种子原则：不写任务系统——只放废墟 + 检查距离 + logEvent
class RuinsSystem {
  id = 'ruins';
  private _throttle = 0;
  private discovered = new Set<number>(); // 已发现的遗迹 key
  private spawned = false;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {
    // 世界生成后放置遗迹（在 init 中做一次）
    // 实际放置在第一次 update 中（确保 world 已完全初始化）
  }

  update(dt: number): void {
    if (!this.spawned) {
      this.spawnRuins();
      this.spawned = true;
    }

    this._throttle += dt;
    if (this._throttle < CFG.checkInterval) return;
    this._throttle = 0;

    // 检查小人是否走近未发现的遗迹
    for (const [k, b] of this.ctx.world.buildings) {
      if (!b.def.tags?.includes('ruin')) continue;
      if (this.discovered.has(k)) continue;
      const { x, y } = World.keyToXY(k);
      for (const eid of this.ctx.iterPawns) {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) continue;
        const d = Math.hypot(pos.x - x, pos.y - y);
        if (d <= CFG.discoverRange) {
          this.discovered.add(k);
          const ruinType = (b.def.meta as Record<string, unknown>)?.ruinType as string ?? '遗迹';
          const story = ((b.def.meta as Record<string, unknown>)?.story as string) ?? '岁月无声';
          this.ctx.logEvent(`🗺 #${eid} 发现了${ruinType}：${story}`);
          // 写入篝火记忆
          const fireId = this.ctx.pawnStates.get(eid)?.fireId;
          if (fireId != null) {
            this.ctx.socialUnits.addMemory(fireId, `发现了${ruinType}：${story}`);
          }
          break;
        }
      }
    }
  }

  private spawnRuins(): void {
    // 在营地外围 10-40 格环带随机放置遗迹
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    const count = 3 + Math.floor(this.ctx.rng.next() * 4); // 3-6 个遗迹
    for (let i = 0; i < count; i++) {
      const ruinType = RUIN_TYPES[Math.floor(this.ctx.rng.next() * RUIN_TYPES.length)]!;
      const r = 10 + this.ctx.rng.next() * 30;
      const a = this.ctx.rng.next() * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      if (!this.ctx.world.inBounds(x, y)) continue;
      // 放置遗迹建筑（hp=1 = 濒毁废墟）
      const placed = this.ctx.world.placeBuilding(x, y, ruinType.building, 'ruins');
      if (placed) {
        // 损坏到 hp=1 + 标记为废墟
        this.ctx.world.damageBuilding(x, y, 99999);
        const story = ruinType.stories[Math.floor(this.ctx.rng.next() * ruinType.stories.length)]!;
        const b = this.ctx.world.getBuilding(x, y);
        if (b) {
          // 修改 meta 标记为遗迹
          (b.def as { meta: Record<string, unknown> }).meta = { ...b.def.meta, ruin: true, ruinType: ruinType.name, story };
        }
        // 重新放回（damageBuilding 会移除）
        this.ctx.world.placeBuilding(x, y, ruinType.building, 'ruins');
        this.ctx.world.damageBuilding(x, y, 99999);
      }
    }
  }
}

export const ruinsPack: ModPack = {
  id: 'ruins',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'ruins', label: '旧世界遗迹', category: 'world',
      ctor: (ctx) => new RuinsSystem(ctx),
    });
  },
};