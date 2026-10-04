/**
 * bootstrap 包 —— 开局引导：落篝火 + 出生鼠群。
 *
 * 为什么是玩法包而非内核：出生内容是"种子"（原则④：内核不塞玩法）。卸载本包 =
 * 空世界起步（测试纯引擎时装最小装配），核心照常运行——卸载不破坏核心的活例证。
 * 类别 'boot' 恒表尾：出生副作用晚于一切系统 init，保证订阅/查询面已就绪
 * （旧项目踩坑：先出生后订阅会丢事件）。
 */
import type { ModPack } from '../pack';
import { K_TAG_FIRE } from '../contracts';
import type { SimContext } from '../../sim/context';

export const bootstrapPack: ModPack = {
  id: 'bootstrap',
  requires: ['building'], // 落篝火依赖 campfire 定义（显式硬依赖）
  apply(m) {
    m.registerSystemDef({
      id: 'bootstrap',
      category: 'boot',
      ctor: (ctx: SimContext) => ({
        id: 'bootstrap',
        init() {
          // ① 出生篝火（若 building 包在场；找不到格就裸生——生存压力即故事）
          const spot = findCampSpot(ctx);
          if (spot) ctx.addBuilding('campfire', spot.x, spot.y);
          // ② 鼠群：散落在锚点附近 ±2 格
          const n = ctx.tuning.bootstrap.pawnCount;
          for (let i = 0; i < n; i++) {
            const ox = spot ? Math.round(ctx.rng() * 4 - 2) : 0;
            const oy = spot ? Math.round(ctx.rng() * 4 - 2) : 0;
            ctx.spawnPawn((spot?.x ?? 0) + ox, (spot?.y ?? 0) + oy);
          }
          ctx.log(`🏕 新营地建立${spot ? '' : '（连篝火都没能立起来……）'}，${n} 只鼠鼠落地`);
        },
      }),
    });
  },
};

/** 营地选址：原点优先，环形外扩找可站可建格 */
function findCampSpot(ctx: SimContext): { x: number; y: number } | null {
  for (let r = 0; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (ctx.passable(dx, dy) && !ctx.nearestBuildingByTag(K_TAG_FIRE, dx, dy, 1)) return { x: dx, y: dy };
      }
    }
  }
  return null;
}
