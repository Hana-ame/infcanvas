// 驯兽守卫 DLC（2026-08-20，用户「继续开发」自主设计，战斗主线延续战场指挥）：
// 把重伤的野猫/哈基米（捕食者）驯化成营地守卫——"以鼠之矛守鼠之城"，
// 与袭击世界观形成张力：野猫叼走鼠，驯服后替营地叼走敌人。
// 机制：
//   ① 驯化入口 = tame 命令（hostileIndex 定位，同 attack/focus 的模式）：
//      仅 hp/maxHp ≤ tameHpRatio(0.25) 的重伤 cat 可驯（垂危才臣服）；驯化中猫
//      趴伏假死（raidSystem 跳过：不追鼠/不叼人/不被反击——"臣服状态"，玩家可
//      随时 release 中止）。
//   ② 驯化进程 = 投喂（每 tick 消耗营地 food，缺粮停滞；progress 累计 tameTime(20s)
//      满 → 驯服成功）；tamer（驯养人，缺省最近活人）死亡 → 驯化中止。
//   ③ 驯服成功 = 转阵营守卫：hostile.faction = 'player'（随局不随档——hostiles 是
//      运行时状态，存档天然不含；读档后守卫野生化，产品语义同 carried 叼鼠的先例）。
//   ④ 守卫行为（本包系统驱动）：营内有敌对猫 → 扑咬（伤害 = 猫速快攻，复用其
//      dmg）；无战 → 跟随驯养人；驯养人死后就地游荡。
//   ⑤ release 命令：放归野生（tamed → faction 还原并解除全部驯化状态）。
// 依赖：无硬前置（requires=[]）——可独立装卸；raidSystem 对 player 阵营/驯化态的
// 跳过是通用状态分支（先例：carried），包卸载后无人写这两个字段自然失效。
// 数值全在 CFG（玩法包自治）：tameHpRatio 0.25 / feedPerSec 0.5 / tameTime 20 /
// guardEngage 8（主动扑咬半径）/ guardDps 6（作为对比：野猫 dmg 5/s）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { Hostile } from '../../sim/systems/context';
import type { ModPack } from '../pack';

const CFG = {
  tameHpRatio: 0.25,     // hp/maxHp ≤ 0.25 才可驯（垂危臣服——满血猫不服管）
  feedPerSec: 0.5,       // 驯化中每秒消耗食物（营地库存；缺粮 = 进度停滞不倒退）
  tameTime: 20,          // 驯化所需累计投喂时长（秒）
  guardEngage: 8,        // 守卫主动扑咬半径（格）
  guardDps: 6,           // 守卫撕咬每秒伤害（略高于野猫 5——驯养伙食好）
};

// ---- 读面 helper（hostile 是运行时对象，直接读写字段，读面=写面）----
const tamingOf = (h: Hostile) => h.taming;
// 判断敌人是否已驯服（faction='player' = 玩方守卫）
const isTamed = (h: Hostile) => h.faction === 'player';

export const beastTamingPack: ModPack = {
  id: 'beast-taming',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'beastTaming', label: '驯兽守卫', category: 'raid',
      // 2026-08-20 顺序审计后已是表内系统：执行序 = 类别序 × 组内注册序推导，不再用 before 锚点。
      ctor: (ctx) => new BeastTamingSystem(ctx),
    });

    // tame 命令（处理器自包含,不依赖系统实例）：{ pawnId?, args:{ hostileIndex } }
    m.registerCommand('tame', (ctx, cmd) => {
      const idx = (cmd.args ?? {}) as { hostileIndex?: unknown };
      const h = Number.isInteger(idx.hostileIndex) ? ctx.hostiles[Number(idx.hostileIndex)] : undefined;
      if (!h) { ctx.logEvent('⚠ 驯化目标不存在'); return; }
      if (h.enemyId !== 'cat') { ctx.logEvent('⚠ 只能驯化野猫（哈基米）'); return; }
      if (h.maxHp > 0 && h.hp / h.maxHp > CFG.tameHpRatio) { ctx.logEvent('⚠ 猫还有力气，先把它打服（血量低于 25%）'); return; }
      if (h.taming || isTamed(h)) { ctx.logEvent('⚠ 这只猫已经在驯化/守卫中'); return; }
      // 驯养人 = 显式 pawnId 或最近活人；无人 → 拒（猫需要有人投喂）
      let tamer: number | null = null;
      if (typeof cmd.pawnId === 'number' && ctx.pawnStates.has(cmd.pawnId)) tamer = cmd.pawnId;
      else {
        let bestD = Infinity;
        for (const eid of ctx.pawnList) {
          const pos = ctx.pawnPositions.get(eid);
          if (!pos) continue;
          const d = Math.hypot(pos.x - h.x, pos.y - h.y);
          if (d < bestD) { bestD = d; tamer = eid; }
        }
      }
      if (tamer === null) { ctx.logEvent('⚠ 营地无人，无法驯化'); return; }
      h.taming = { progress: 0, tamer };
      ctx.logEvent(`🪤 对重伤的野猫展开驯化（#${tamer} 投喂中）`);
    });

    // release 命令：放归野生（中止驯化 / 解除守卫）
    m.registerCommand('release', (ctx, cmd) => {
      const idx = (cmd.args ?? {}) as { hostileIndex?: unknown };
      const h = Number.isInteger(idx.hostileIndex) ? ctx.hostiles[Number(idx.hostileIndex)] : undefined;
      if (!h) { ctx.logEvent('⚠ 没有选中目标'); return; }
      if (h.taming) {
        delete h.taming;
        ctx.logEvent('🪝 中止驯化，野猫恢复野性');
      } else if (isTamed(h)) {
        h.faction = '';
        delete h.owner;
        ctx.logEvent('🪝 守卫猫放归山林');
      } else {
        ctx.logEvent('⚠ 它不是驯化中的猫');
      }
    });
  },
};

// 驯兽守卫系统：驯化进度（投喂消耗 food 节流）→ 转正后守卫行为（扑咬/跟随/游荡）
// 2026-08-20：节流 1s（驯化进度 + 守卫 AI 不需要每帧评估）
export class BeastTamingSystem {
  id = 'beastTaming';

  constructor(private ctx: SimContext) {}

  init(): void {}

  private _throttle = 0;
  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 1) return;
    this._throttle = 0;
    // 节流：驯化/守卫行为 1s 评估一次
    // ---- 驯化推进（先于守卫段——新驯服的猫本帧起按守卫跑）----
    for (const h of this.ctx.hostiles) {
      const t = tamingOf(h);
      if (!t) continue;
      // 驯养人死亡 → 中止（无人投喂的猫恢复野性）
      if (!this.ctx.pawnStates.has(t.tamer)) {
        delete h.taming;
        this.ctx.logEvent('🐱 驯养人倒下了，野猫挣脱驯化');
        continue;
      }
      // 投喂：库存 food 足够才推进并消耗；缺粮停滞（不倒退——垂危猫没力气逃走）
      const feed = CFG.feedPerSec * dt;
      if ((this.ctx.stockpile.food ?? 0) < feed) continue;
      this.ctx.stockpile.food -= feed;
      this.ctx.recordSpend(null, 'food', feed); // 驯化投喂也是营地支出（economy 记账纪律）
      t.progress += dt;
      if (t.progress >= CFG.tameTime) {
        h.owner = t.tamer; // 驯养人转入 owner（跟随目标；主人逝去 → 就地游荡）
        delete h.taming;
        h.faction = 'player'; // 转阵营：营地守卫（raidSystem 对其跳过敌对结算）
        this.ctx.logEvent('🐱❤️ 野猫被驯服，成了营地守卫！');
      }
    }

    // ---- 守卫行为驱动（tamed 猫由本系统管,不进 raidSystem 敌对循环）----
    for (const h of this.ctx.hostiles) {
      if (!isTamed(h)) continue;
      // 找最近敌对猫（未驯化/未转阵营的敌对单位）
      let target: Hostile | null = null;
      let bestD = CFG.guardEngage;
      for (const e of this.ctx.hostiles) {
        if (e === h || e.faction === 'player' || e.taming) continue;
        const d = Math.hypot(e.x - h.x, e.y - h.y);
        if (d < bestD) { bestD = d; target = e; }
      }
      if (target) {
        // 有敌：扑向目标撕咬（直线移动 + 伤害——hostiles 无寻路，直接逼近）
        const d = Math.hypot(target.x - h.x, target.y - h.y);
        const step = (h.speed ?? 3.5) * dt;
        if (d > 0.8) {
          h.x += ((target.x - h.x) / d) * step;
          h.y += ((target.y - h.y) / d) * step;
        } else {
          target.hp -= CFG.guardDps * dt;
          // 2026-08-20 修复守卫猫无敌：被咬的敌方猫反击守卫猫（此前 raidSystem 跳过
          // player faction → 无路径对守卫猫造成伤害 → 守卫猫永不被杀。这里补：目标
          // 活着且近身时，以敌方猫的 dmgPerSec 反击守卫猫。守卫猫 hp 归零 → 移除）
          if (target.hp > 0 && (target.dmgPerSec ?? 0) > 0) {
            h.hp -= (target.dmgPerSec ?? 0) * dt;
            if (h.hp <= 0) {
              const idx = this.ctx.hostiles.indexOf(h);
              if (idx >= 0) this.ctx.hostiles.splice(idx, 1);
              this.ctx.logEvent('💔 营地守卫猫在战斗中牺牲！');
            }
          }
        }
        continue;
      }
      // 无战：跟随驯养人（直线靠近，近旁 2.5 格停下；主人逝去/无主 → 就地游荡不动）
      const owner = h.owner;
      if (owner === undefined || !this.ctx.pawnStates.has(owner)) continue;
      const pos = this.ctx.pawnPositions.get(owner);
      if (!pos) continue;
      const d = Math.hypot(pos.x - h.x, pos.y - h.y);
      if (d > 2.5) {
        const step = (h.speed ?? 3.5) * dt;
        h.x += ((pos.x - h.x) / d) * step;
        h.y += ((pos.y - h.y) / d) * step;
      }
    }
  }
}