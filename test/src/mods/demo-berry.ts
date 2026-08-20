// 示例玩法包：浆果（2026-08-14 完全插件化：旧式函数 mod → ModPack 格式）
// 背景：本文件原是 `export default (m) => void` 的函数式 mod（与 ModPack 双格式并存）。
// 完全插件化裁决：统一为 ModPack（id + requires + apply），可进依赖图、可远程加载。
// 加载：registry.mount(demoBerryPack)（dev）；默认装配不挂本包（示例用）。
// 依赖：gathering（harvest 需采集系统结算浆果丛产出）。berrySpoil 的 before:'autobuild'
// 只是表位锚点（缺该锚点则追加表尾），不构成对 autobuild 包的依赖。
// 演示数据驱动能力：
//   1. 新建筑（浆果摊）自动进建造菜单，可放置、可渲染（复用 building:farm 素材）
//   2. 新 tile（浆果丛）进世界生成采样，渲染不崩（def.color 色块 + 复用 terrain:tree 图标）
//   3. 小人自动采集新 tile（growable + harvest 声明，无需改采集系统）
//   4. 逻辑组件层：谓词 + 声明式卡（浆果≥5 时小人庆祝）+ 系统装配（浆果每 60s 变质减半，before 锚点插入）
import type { ModRegistry, HookContext } from '../sim/mods/registry';
import type { ModPack } from './pack';

export const demoBerryPack: ModPack = {
  id: 'demo-berry',
  // 依赖（2026-08-20 审计中②）：gathering——浆果丛接入采集管线（可通行灌木 growable+harvest）；
  // farming——浆果摊 passive 配方由 farm 系统（systems/farmSystem.ts）结算，缺装时
  // "静默不产出"（此前 requires 只写 gathering——没种田包就没有被动产粮结算者）
  requires: ['gathering', 'farming'],
  name: '浆果玩法示例',
  apply(m: ModRegistry): void {
    m.registerItem({ id: 'berry', name: '浆果' });

    m.registerTile({
      id: 'berryBush',
      name: '浆果丛',
      passable: true,
      buildable: true,
      color: '#7a4a3a',
      growable: true,
      sprite: 'terrain:tree',
      harvest: { product: 'berry', time: 1.5, yieldSuccess: 4, yieldFail: 1, dc: 50 },
      harvestReplaces: 'grass',
    });

    m.registerRecipe({
      id: 'berryStandRecipe',
      name: '浆果摊',
      kind: 'passive',
      output: { item: 'berry', amount: 0.15 },
    });

    m.registerBuilding({
      id: 'berryStand',
      name: '浆果摊',
      size: { x: 1, y: 1 },
      hp: 80,
      color: '#a05a4a',
      emoji: '🫐',
      passable: true,
      buildTime: 2,
      costWood: 4,
      sprite: 'building:farm',
      recipe: 'berryStandRecipe',
    });

    // 4. 逻辑组件层：卡条件谓词（浆果充足时才抽"浆果盛宴"）
    m.registerPredicate('stockpileBerry', (c) => (c.view.stockpile.berry ?? 0) >= 5);
    m.registerCardDef({
      id: 'berryFeast', name: '浆果盛宴', series: 'leisure', weight: 3,
      when: ['stockpileBerry'],
      utilityFixed: 18,
      action: 'idle', label: '浆果盛宴',
      satisfies: [{ desire: 'sloth', amount: 1 }],
    });

    // 5. 逻辑组件层：系统装配表插入（浆果保质：每 60s 库存减半，before autobuild）
    m.registerSystemDef({
      id: 'berrySpoil', label: '浆果变质', category: 'production', before: 'autobuild',
      // 系统闭包只用 SimContext（2026-08-20 审计中④：此前直用 sim——绕过 ctx 面无法最小
      // ctx 单测；stockpile/logEvent 均在 SimContext 接口内）
      ctor: (ctx) => {
        let acc = 0;
        return {
          id: 'berrySpoil',
          update(dt: number): void {
            acc += dt;
            if (acc >= 60) {
              acc = 0;
              const b = ctx.stockpile.berry ?? 0;
              if (b > 0) {
                ctx.stockpile.berry = Math.max(0, Math.floor(b / 2));
                ctx.logEvent('🫐 浆果变质了一批');
              }
            }
          },
        };
      },
    });

    // 开局在出生点周围撒几丛浆果（演示 mod tile 出现在世界；仅铺一次）
    let seeded = false;
    m.registerHook('step:after', ({ sim }: HookContext): void => {
      if (seeded) return;
      seeded = true;
      const cx = Math.floor(sim.world.width / 2);
      const cy = Math.floor(sim.world.height / 2);
      const spots = [[cx + 4, cy + 1], [cx - 3, cy + 3], [cx + 2, cy - 4], [cx - 5, cy - 2]];
      for (const [x, y] of spots) {
        if (sim.world.inBounds(x, y)) sim.world.setTile(x, y, 'berryBush');
      }
    });
  }
};

// 默认导出 = 包对象（兼容 pack.ts loadRemote 的 default export 约定；旧式函数 mod 调用方已迁移）
export default demoBerryPack;