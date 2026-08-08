// 示例 mod：浆果玩法（不碰内核源码）
// 加载：?mods=/src/mods/demo-berry.ts（dev）；build 场景内联挂载（new Sim({ mods })）
// 演示三项数据驱动能力：
//   1. 新建筑（浆果摊）自动进建造菜单，可放置、可渲染（复用 building:farm 素材）
//   2. 新 tile（浆果丛）进世界生成采样，渲染不崩（def.color 色块 + 复用 terrain:tree 图标）
//   3. 小人自动采集新 tile（growable + harvest 声明，无需改采集系统）
import type { ModRegistry, HookContext } from '../sim/mods/registry';

export default (m: ModRegistry): void => {
  m.registerItem({ id: 'berry', name: '浆果', stackable: true, maxStack: 99 });

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
};
