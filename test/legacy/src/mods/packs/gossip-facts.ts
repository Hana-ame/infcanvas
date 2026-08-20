// 传闻引用 DLC 事实 DLC（2026-08-20，用户设计：义体/圣典/杰作/事件 → 社交传闻素材）
// 种子原则：不写新系统——只在相关事件发生时把事实写入篝火记忆（addMemory），
// 社交系统的 exchangeFireStory 自然读取 → 聊天中引用。
// 事实来源：masterpiece_created / faction_event / building_built / pawn_spawned / raid_started
// → 全部通过 bus.on 监听 → addMemory → 进入社交循环。零机制链。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus, GameEvent } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  memoryMaxPerFire: 20,  // 每个篝火最多记 20 条事实（防膨胀）
};

// 事实文本生成：把 GameEvent → 一句话
function eventToFact(ev: GameEvent): string | null {
  switch (ev.type) {
    case 'masterpiece_created' as string:
      return `听说 ${(ev as { eid: number }).eid} 号打造了杰作`;
    case 'building_built':
      return `建起了${(ev as { defId: string }).defId === 'church' ? '教堂' : '建筑'}`;
    case 'pawn_spawned':
      return `迎来了新成员 #${(ev as { eid: number }).eid}`;
    case 'pawn_died':
      return `#人 ${(ev as { eid: number }).eid} 离开了我们`;
    case 'raid_started':
      return `敌袭来了！${(ev as { count: number }).count} 只`;
    case 'faction_event':
      return `阵营变化：${(ev as { kind: string }).kind}`;
    default:
      return null;
  }
}

// 传闻事实系统：监听所有事件 → 转成事实文本 → 写入篝火记忆 → 社交系统自然引用
// 零机制链：只 bus.onAny → addMemory，不写新系统逻辑
class GossipFactsSystem {
  id = 'gossip-facts';

  constructor(private ctx: SimContext) {}

  init(bus: EventBus): void {
    // 监听所有事件 → 转成事实 → 写入最近的篝火记忆
    bus.onAny((ev: GameEvent) => {
      if (ev.type === 'gossip_spread' || ev.type === 'social' || ev.type === 'mood_changed' || ev.type === 'rest' || ev.type === 'eat' || ev.type === 'resource_gained') return; // 跳过内部事件
  const fact = eventToFact(ev);
      if (!fact) return;
      // 找最近的篝火（以第一个 campfire 为锚点）
      let fireKey: number | undefined;
      for (const [k, b] of this.ctx.world.buildings) {
        if (b.def.id === 'campfire' || b.def.id === 'church') { fireKey = k; break; }
      }
      if (fireKey !== undefined) {
        this.ctx.socialUnits.addMemory(fireKey, fact);
      }
    });
  }

  update(_dt: number): void {
    // 纯被动：只在事件触发时写记忆，不做每帧检查
  }
}

export const gossipFactsPack: ModPack = {
  id: 'gossip-facts',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'gossip-facts', label: '传闻事实', category: 'society',
      ctor: (ctx) => new GossipFactsSystem(ctx),
    });
  },
};