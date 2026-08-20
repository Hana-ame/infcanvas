// 囚犯玩法包（2026-08-14，插件化大系统实验：俘虏/囚笼/招降）
// 背景：战斗只有"打死夺宝"一条路（raidSystem 把敌人 hp 打穿即移除）。本包加第三条路：
// 把垂死敌人拖进囚笼养着，喂食感化 → 转正入伙；断粮/长久无望 → 挣脱逃跑。
// 机制：
//   ① 新建筑 'cage'（def.meta.prison = { capacity }
//   ② 俘虏来源：raidSystem 每帧战斗把敌人打到 hp<25%（濒死）→ 本系统（before 'raid'，
//      先于战斗结算捕获扫描，比战斗先抓走）检查场内有空笼 → 直接从 hostiles 移除并
//      关入最近空笼（叙事：鼠鼠们把垂死敌人拖进笼子，LogEvent 说明）
//   ③ 俘虏状态存笼子建筑 extra（依赖内核存档扩展点）：{ enemyId, name, capturedAt, lastFed, rolls }
//      → 随档持久（读档后囚犯还在笼子里）
//   ④ 演化（低频 40s）：喂食（扣全局 1 food）→ 无食则挣脱逃走；每 120s 招降检定
//      rollEventSkill(social) —— 成功 → spawnPawn 转正入伙（新成员）；失败 → 继续关押
// 装配：before 'raid'，默认挂载。无笼子不俘获（玩家建笼才有俘虏玩法）。
// ⚠️ 2026-08-14 review 修复：笼子坐标此前用 `key % world.width` 解码（旧 key 公式），
// 新 key 编码（x + y*2^31）下该公式完全错乱（y 解码成上亿假坐标）→ 捕获距离判定与
// 招降 spawn 位置全错；改 World.keyToXY 解码。另修复逃逸条件：只放走"从未喂过"的
// 囚犯，喂过之后断粮的囚犯被无限关押（见 update 内注释）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { BuildingData } from '../../sim/core/world';
import { World } from '../../sim/core/world';
import type { ModPack } from '../pack';

// 本包数值
const CFG = {
  captureAt: 0.25,  // 敌人 hp 比例低于此视为"垂死可俘"（25%）
  feedInterval: 40, // 喂食/逃走检查周期（秒）
  foodPerFeed: 1,   // 每次喂食消耗的食物
  convertInterval: 120, // 招降检定周期（秒）
  convertDc: 55,    // 招降检定 DC（social 技能百分制；喂食有加成）
  fedBonus: 15,     // 上一轮喂过食 → 招降检定加成
};

// meta.prison 语义：capacity = 笼子关押上限（默认 1）
interface PrisonMeta { capacity?: number }

// 读取建筑囚笼配置（meta.prison = 俘获容量/喂食间隔等）
const prisonOf = (b: BuildingData): PrisonMeta | undefined => b.def.meta?.prison as PrisonMeta | undefined;

export const prisonPack: ModPack = {
  id: 'prison',
// 依赖（2026-08-15 显式化）：无硬前置——囚笼建筑自注册
  requires: [],
  apply(m: ModRegistry): void {
  m.registerBuilding({
    id: 'cage', name: '囚笼', size: { x: 1, y: 1 }, hp: 180, color: '#4a4a5a',
    emoji: '⛓️', passable: false, buildTime: 4,
    tags: ['prison'], meta: { prison: { capacity: 1 } },
    costWood: 15,
  });
  m.registerSystemDef({
    id: 'prison', label: '囚笼', category: 'production',
    ctor: (sim) => new PrisonSystem(sim),
    // 表内系统不设 before：执行序 = 类别序 × 组内注册序推导（SYSTEM_DEFS 表位置定序；
    // before 锚点仅第三方表外系统专用——2026-08-20 审计 L7 清理死锚点）
  });
  },
};

interface Captive {
  enemyId?: string;
  name: string;
  capturedAt: number;
  lastFed: number;   // 上次喂食时间（< 0 = 没喂过）
  rolls: number;     // 招降尝试次数
}

// 囚犯系统：捕获（濒死敌人拖笼）→ 养（喂食/逃跑）→ 招降（转正入伙）
// 状态存笼子 extra（随档），无宿主全局表——卸载本系统不影响 sim 其余部分
export class PrisonSystem {
  id = 'prison';
  private feedTimer = 0;
  private convertTimer = 0;

  constructor(private ctx: SimContext) {}

  init(): void {}

  private cages(): { key: number; b: BuildingData; cap: number; captive: Captive | null }[] {
    const out: { key: number; b: BuildingData; cap: number; captive: Captive | null }[] = [];
    for (const [key, b] of this.ctx.world.buildings) {
      const p = prisonOf(b);
      if (!p) continue;
      out.push({ key, b, cap: p.capacity ?? 1, captive: (b.extra?.captive as Captive | undefined) ?? null });
    }
    return out;
  }

  update(dt: number): void {
    // ① 捕获扫描（每帧，before raid：垂死敌人先被拖走，轮不到 raidSystem 补刀）
    const cages = this.cages();
    const freeCage = cages.find((c) => !c.captive);
    if (freeCage) {
      // 新 key 编码（2026-08-14 无限地图）：必须 World.keyToXY 解码（review 修复：
      // 旧 `key % w` 公式 y 坐标乱到上亿 → 捕获距离判定全错）
      const { x: cx, y: cy } = World.keyToXY(freeCage.key);
      // 找场内濒死敌人（近笼优先——拖得近才救得回）
      let best: number = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.ctx.hostiles.length; i++) {
        const h = this.ctx.hostiles[i];
        if (h.hp > h.maxHp * CFG.captureAt) continue;
        const d = (h.x - cx) ** 2 + (h.y - cy) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        const h = this.ctx.hostiles[best];
        freeCage.b.extra = freeCage.b.extra ?? {};
        freeCage.b.extra.captive = {
          enemyId: h.enemyId, name: h.name ?? '敌人', capturedAt: this.ctx.time,
          lastFed: -1, rolls: 0,
        } as Captive;
        this.ctx.hostiles.splice(best, 1);
        this.ctx.logEvent(`⛓️ 鼠鼠们把垂死的${h.name ?? '敌人'}拖进了囚笼`);
      }
    }

    // ② 喂养/逃跑（低频）
    this.feedTimer -= dt;
    if (this.feedTimer <= 0) {
      this.feedTimer = CFG.feedInterval;
      for (const c of this.cages()) {
        if (!c.captive) continue;
        if ((this.ctx.stockpile.food ?? 0) >= CFG.foodPerFeed) {
          this.ctx.stockpile.food = Math.max(0, (this.ctx.stockpile.food ?? 0) - CFG.foodPerFeed);
          this.ctx.recordSpend(null, 'food', CFG.foodPerFeed); // 记账（审计中③）：喂食是营地支出，此前漏记
          c.captive.lastFed = this.ctx.time;
        } else if (this.ctx.time - (c.captive.lastFed >= 0 ? c.captive.lastFed : c.captive.capturedAt) > CFG.feedInterval * 2) {
          // 断粮挣脱（review 修复）：此前只放走"从未喂过"的囚犯——喂过之后断粮的
          // 囚犯被无限关押、永不逃走，与"断粮/长久无望 → 挣脱逃跑"的设计矛盾；
          // 现在无论是否喂过，自上次进食（或入狱）起断粮超 2 个周期即逃。
          delete c.b.extra!.captive;
          this.ctx.logEvent(`🏃 ${c.captive.name}挣脱囚笼逃走了`);
        }
      }
    }

    // ③ 招降检定（低频；social 技能 vs DC，喂过食加成）
    this.convertTimer -= dt;
    if (this.convertTimer <= 0) {
      this.convertTimer = CFG.convertInterval;
      for (const c of this.cages()) {
        if (!c.captive) continue;
        const fed = c.captive.lastFed >= 0 && this.ctx.time - c.captive.lastFed < CFG.feedInterval * 2;
        // 感化主体 = 营地 social 技能最高的鼠鼠（说服力最强的人去劝降）
        let persuader = -1;
        let bestSkill = -1;
        for (const eid of this.ctx.iterPawns) {
          const s = this.ctx.skillOf(eid, 'social');
          if (s > bestSkill) { bestSkill = s; persuader = eid; }
        }
        if (persuader === -1) continue; // 营地没人 → 囚犯自生自灭（无人感化）
        const r = this.ctx.rollEventSkill(persuader, CFG.convertDc - (fed ? CFG.fedBonus : 0), 'social');
        c.captive.rolls++;
        if (r.success) {
          // 新 key 编码（2026-08-14 无限地图）：必须 World.keyToXY 解码（与捕获扫描同修）
          const { x: cx, y: cy } = World.keyToXY(c.key);
          const eid = this.ctx.spawnPawn(cx, cy + 1);
          if (eid !== -1) {
            const name = c.captive.name;
            delete c.b.extra!.captive;
            this.ctx.logEvent(`🤝 ${name}被感化，加入了部落（共招降 ${c.captive.rolls} 次）`);
          } else {
            this.ctx.logEvent(`🤝 感化成功，但${c.captive.name}无处落脚（营地爆满）`);
          }
        } else {
          this.ctx.logEvent(`😠 囚犯${c.captive.name}拒绝归顺（第 ${c.captive.rolls} 次招降失败）`);
        }
      }
    }
  }
}
