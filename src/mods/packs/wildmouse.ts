// 野生鼠鼠玩法包（2026-08-14：遭遇/加入/竞争随机事件）
// 背景：内核 raidSystem 只有周期性野猫袭击（一波接一波，没有"偶遇"感）；
// 事件系统（events）可挂脚本化事件。本包做一个"野生鼠鼠群落遭遇"事件：
// 和平期偶遇 → 三岔路口（30% 加入部落 / 35% 竞争冲突 / 35% 路过观望）。
// 与袭击的差异：不是地图边缘刷波直冲营地，而是在营地近旁随机起舞——
// 群落规模小（1-2 只）、无叙事压力放大、触发由事件池权重决定（cooldown 控制频率）。
// 依赖：内核 events（事件池）/ raid（hostile 战斗结算）/ population（spawnPawn）。
// 装配：默认挂载（registry.default）。
import type { ModPack } from '../pack';

export const wildmousePack: ModPack = {
  id: 'wildmouse',
// 依赖（2026-08-15 显式化）：无硬前置——剧本事件自注册
  requires: [],
  apply(m): void {
    m.registerEvent({
      id: 'wildEncounter',
      name: '野生鼠鼠',
      weight: 50,           // 事件池权重（默认事件同池竞争）
      cooldown: 150,        // 距上次至少 2.5 分钟
      minTime: 60,          // 开局 1 分钟后才可能出现（先建家）
      condition: (ctx) => ctx.pawnList.length > 0 && ctx.hostiles.length === 0, // 和平期才有遭遇窗口
      run(ctx) {
        const w = ctx.world;
        const cx = Math.floor(w.width / 2), cy = Math.floor(w.height / 2);
        const r = ctx.rng.next();
        if (r < 0.3) {
          // ① 加入：营地近旁随机空地刷一只新成员（出生即入队）
          for (let i = 0; i < 6; i++) {
            const x = cx + ctx.rng.int(-6, 6), y = cy + ctx.rng.int(-6, 6);
            const eid = ctx.spawnPawn(x, y);
            if (eid !== -1) {
              ctx.logEvent('🐭 一只野生鼠鼠被部落烟火吸引，决定加入！');
              return;
            }
          }
          ctx.logEvent('🐭 一只野生鼠鼠在营地外探头探脑，最后离开了（无处落脚）');
        } else if (r < 0.65) {
          // ② 竞争：1-2 只流浪鼠群争夺地盘（小而快，无压力放大）
          const enemy = ctx.mods.enemyDef();
          const n = 1 + (ctx.rng.next() < 0.4 ? 1 : 0);
          const edgeSide = ctx.rng.int(0, 3);
          for (let i = 0; i < n; i++) {
            let x = cx + ctx.rng.int(-4, 4), y = cy + ctx.rng.int(-4, 4);
            if (edgeSide === 0) y = ctx.rng.int(0, 3);
            else if (edgeSide === 1) y = w.height - 1 - ctx.rng.int(0, 3);
            else if (edgeSide === 2) x = ctx.rng.int(0, 3);
            else x = w.width - 1 - ctx.rng.int(0, 3);
            // 竞争分支：手工快照 EnemyDef 字段（与 raidSystem 生成路径重复——审计 2026-08-15
            // 登记：EnemyDef 增字段不会自动透传，两处敌人行为可能漂移；将来抽共享 spawnHostile helper）
            ctx.hostiles.push({
              x, y, hp: enemy.hp, maxHp: enemy.hp,
              targetX: cx, targetY: cy,
              name: enemy.name, enemyId: enemy.id, faction: enemy.faction,
              speed: enemy.speed, dmgPerSec: enemy.dmg, loot: enemy.loot,
            });
          }
          ctx.logEvent(`🐭 几只野生鼠鼠红着眼扑上来抢吃的！（${n} 只）`);
        } else {
          // ③ 路过观望：围观看热闹，心情小波动（无害但吵闹）
          const mood = -0.1 * ctx.rng.next(); // 轻微烦躁（占窝）
          for (const eid of ctx.pawnList) {
            ctx.adjustMood(eid, mood);
          }
          ctx.logEvent('🐭 一群野生鼠鼠在营地边路过，探头探脑看了会热闹');
        }
      },
    });
  },
};