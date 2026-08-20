// 浆果玩法 scripts（函数式扩展：谓词 + 系统 + 钩子）
// 沙箱执行：new Function('m', 'console', src)——无 import/require，只能调用注入的 m/console
m.registerPredicate('stockpileBerry', (c) => (c.view.stockpile.berry ?? 0) >= 5);

// 浆果保质：每 60s 库存减半（系统装配表 before: autobuild 锚点插入）
m.registerSystemDef({
  id: 'berrySpoil',
  label: '浆果变质',
  category: 'production',
  before: 'autobuild',
  ctor: (sim) => {
    let acc = 0;
    return {
      id: 'berrySpoil',
      update(dt) {
        acc += dt;
        if (acc >= 60) {
          acc = 0;
          const b = sim.stockpile.berry ?? 0;
          if (b > 0) {
            sim.stockpile.berry = Math.max(0, Math.floor(b / 2));
            sim.logEvent('浆果变质了一批');
          }
        }
      },
    };
  },
});

// 开局在出生点周围撒几丛浆果（演示 mod tile 出现在世界；仅铺一次）
let seeded = false;
m.registerHook('step:after', ({ sim }) => {
  if (seeded) return;
  seeded = true;
  const cx = Math.floor(sim.world.width / 2);
  const cy = Math.floor(sim.world.height / 2);
  const spots = [[cx + 4, cy + 1], [cx - 3, cy + 3], [cx + 2, cy - 4], [cx - 5, cy - 2]];
  for (const [x, y] of spots) {
    if (sim.world.inBounds(x, y)) sim.world.setTile(x, y, 'berryBush');
  }
});