// 采集狩猎玩法包（2026-08-14 用户："现在只留采集狩猎"；2026-08-14 完全插件化：函数式 → ModPack）
// 独立玩法包示例：卸载 farm/craft/techPool/autobuild/repair → 无耕种/手作/科技/自主扩张，纯采集 + 狩猎。
// 格式统一背景：原为 `export default (m) => void`（与 ModPack 双格式并存，不在默认装配），
// 现改为 ModPack（id + requires + apply）——可进依赖图/远程加载，加载 = registry.mount()。
// 依赖：gathering（狩猎玩法也要采集食物；gather 系统已随完全插件化迁出内核为玩法包）。
// 机制：
//   1. disableSystem 卸载默认系统（装配过滤，见 sim.registerSystems）
//   2. 猫掉肉：overrideDef 野猫 loot → food（击杀私有化进个人口袋，见 raidSystem）
//   3. 野外常驻猎物：mod 系统（huntWildSpawn）周期性在营地外刷少量游荡野猫（不是袭击波）
//   4. 狩猎卡 + hunt 工作：小人主动找猫 → 走过去 → 插件系统推进攻击 → 猫死掉肉
//   5. 采集侧重：tuning 调高食物采集产出 + 人口阈值放宽
import type { ModRegistry, HookContext } from '../sim/mods/registry';
import type { SimContext } from '../sim/systems/context';
import { World } from '../sim/core/world';
import type { ModPack } from './pack';

export const hunterGathererPack: ModPack = {
  id: 'hunter-gatherer',
  name: '采集狩猎玩法包',
  requires: ['gathering'],
  apply(m: ModRegistry): void {
  // 1) 卸载与纯采集狩猎无关的默认系统（raid 也卸载：hg 里猫纯猎物，无袭击波——
  //    发现背景：raid 波猫袭击 → 战斗死亡 → 目睹死亡理智崩溃（shock 12）→
  //    30 分钟局 5-6/11 人崩溃。猎物猫的移动/战斗由 huntWildSpawn/huntCombat 承接）
  //    medicine 也卸载：猫咬 → 掉血 → bleed 流血伤口 → san -0.6/s/条 → 崩溃者
  //    被 job 覆盖无法治疗 → 伤口持续 → SAN 恒 0 永久锁死（30 分钟局 12/13 崩溃的
  //    真凶——不是 nightDrain/trauma）。hg 是野外游牧：伤势不扰心智（皮糙肉厚），
  //    伤口层留给定居玩法包。
  for (const id of ['farm', 'craft', 'techPool', 'autobuild', 'repair', 'raid', 'medicine']) m.disableSystem(id);

  // 2) 野猫掉肉（击杀 → 个人口袋 food）
  m.overrideDef('enemy', 'cat', { loot: { item: 'food', amount: 4 }, dmg: 4, hp: 40 });

  // 3) 野外常驻猎物：每 ~40s 在营地外环带刷 1-3 只游荡野猫（非袭击波，纯猎物）
  m.registerSystemDef({
    id: 'huntWildSpawn', label: '野外猎物', category: 'raid', before: 'raid',
    ctor: (sim) => {
      let acc = 0;
      return {
        id: 'huntWildSpawn',
        init: () => {},
        update(dt: number) {
          acc += dt;
          if (acc < 40) return;
          acc = 0;
          // 猫数量上限（防堆积）：场内已有 ≥6 只野猫不再刷
          const cats = sim.hostiles.filter((h) => h.enemyId === 'cat').length;
          if (cats >= 6) return;
          // 营地外环带随机位置（远于 15 格，避免出生点被围攻；收缩自 20-60——
          // raid 卸载后猫静止于刷点，20-60 格时大部分在 huntNearby(25) 外不可猎）
          const cx = Math.floor(sim.world.width / 2);
          const cy = Math.floor(sim.world.height / 2);
          const r = 15 + Math.floor(sim.rng.next() * 25);
          const a = sim.rng.next() * Math.PI * 2;
          const x = Math.round(cx + Math.cos(a) * r);
          const y = Math.round(cy + Math.sin(a) * r);
          // 发现背景：刷点不查地形 → 猫刷在水/山上，小人 A* 绕水每 pathCd 重寻路
          // 且永远打不到（water 不可走）→ behavior 系统 11ms/帧，200s 局 wall 60s。
          if (!sim.world.inBounds(x, y) || !sim.world.isPassable(x, y)) return;
          const count = 1 + Math.floor(sim.rng.next() * 3);
          const enemy = sim.mods.enemyDef('cat');
          for (let i = 0; i < count; i++) {
            // 发现背景：此前 target 指向地图中心 → 猎物猫直奔营地拆篝火，
            // 与 campRebuild 重建形成拉锯战，聚居永远不稳定（1000s 内篝火 8 次被拆）。
            // 修复 v2：target 改为营地周边 15-25 格环带内游荡点——既不直奔营地拆家，
            // 又保持在狩猎卡 huntNearby 半径(25)可及范围（纯环带外猫永远不可猎，
            // 1800s 局猎杀 0 次，狩猎玩法形同虚设；20-30 格时仍有部分猫在 25 格外）。
            const targetR = 15 + Math.floor(sim.rng.next() * 10);
            const ta = sim.rng.next() * Math.PI * 2;
            // 游荡点也须可走（同上：猫停在水上 = 永远猎不到 + 小人绕水空跑）；
            // 不可走时退化为沿 x 平移找可走点，仍不可走则丢弃该只（防刷出废猫）
            let tx = Math.max(1, Math.min(sim.world.width - 2, Math.round(cx + Math.cos(ta) * targetR)));
            let ty = Math.max(1, Math.min(sim.world.height - 2, Math.round(cy + Math.sin(ta) * targetR)));
            if (!sim.world.isPassable(tx, ty)) {
              const dir = sim.rng.next() < 0.5 ? 1 : -1;
              let placed = false;
              for (let s = 1; s <= 6 && !placed; s++) {
                const nx = Math.max(1, Math.min(sim.world.width - 2, tx + dir * s));
                if (sim.world.isPassable(nx, ty)) { tx = nx; placed = true; }
                if (!placed) {
                  const ny = Math.max(1, Math.min(sim.world.height - 2, ty + dir * s));
                  if (sim.world.isPassable(tx, ny)) { ty = ny; placed = true; }
                }
              }
              if (!placed) continue;
            }
            sim.hostiles.push({
              x, y, hp: enemy.hp, maxHp: enemy.hp,
              targetX: tx, targetY: ty,
              name: enemy.name, enemyId: enemy.id, faction: enemy.faction,
              speed: enemy.speed, dmgPerSec: enemy.dmg, loot: enemy.loot,
            });
          }
        },
      };
    },
  });

  // 4) 狩猎：卡 + 工作执行器
  m.registerWork('hunt', (c: SimContext, eid: number, st) => {
    const pos = c.pawnPositions.get(eid);
    if (!pos) return;
    // 已有目标且猫还活着 → 复用目标（只走路，不重扫）
    if (st.huntTarget) {
      const alive = c.hostiles.some((h) => Math.hypot(h.x - st.huntTarget!.x, h.y - st.huntTarget!.y) < 2.5);
      if (alive) {
        st.job = '狩猎';
        // pathCd 节流中（刚寻过路）→ 不重试，直接返回
        if ((st.pathCd ?? 0) > 0) return;
        // 发现背景：moveAdjacent 寻路失败（猫在水中央等不可达）不设 pathCd →
        // 每帧全图 A* 大水漫灌（单帧 228ms，200s 局 wall 74s）。失败即放弃目标 + 长冷却。
        if (!c.moveAdjacent(eid, st.huntTarget.x, st.huntTarget.y)) {
          st.huntTarget = undefined;
          st.huntScanCd = 8;
          st.job = '闲逛';
        }
        return;
      }
      st.huntTarget = undefined;
    }
    // 发现背景：无目标缓存 + 无扫描冷却 → 卡提权后选中频繁，每帧全图扫 hostiles + 寻路，
    // 30 分钟局从 20s 慢到 240s+ 超时（与 chop 的 farScanCd 同源问题）。加 2s 扫描冷却。
    if ((st.huntScanCd ?? 0) > 0) { st.job = '闲逛'; return; }
    // 找最近的猫（比袭击 combat 的 meleeRange 更远一点的主动索敌半径）
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const h of c.hostiles) {
      const d = (h.x - pos.x) ** 2 + (h.y - pos.y) ** 2;
      if (d < bestD) { bestD = d; best = { x: h.x, y: h.y }; }
    }
    if (!best) { st.job = '闲逛'; return; }
    st.huntTarget = best;
    st.job = '狩猎';
    st.huntScanCd = 2;
    c.moveAdjacent(eid, best.x, best.y);
  });

  // 狩猎攻击推进系统：小人 huntTarget 到近旁后每帧对目标猫造成伤害（杀猫掉肉）
  m.registerSystemDef({
    id: 'huntCombat', label: '狩猎攻击', category: 'raid', before: 'raid',
    ctor: (sim) => ({
      id: 'huntCombat',
      init: () => {},
      update(dt: number) {
        for (const eid of sim.pawnList) {
          const st = sim.pawnStates.get(eid);
          const pos = sim.pawnPositions.get(eid);
          if (!st || !pos) continue;
          // 狩猎扫描冷却递减（执行器只置位，这里负责衰减）
          if (st.huntScanCd) st.huntScanCd = Math.max(0, st.huntScanCd - dt);
          if (!st.huntTarget) continue;
          const t = st.huntTarget;
          // 目标超时放弃：追猫超过 45s 未近身（猫在水上/建筑中打不到）→ 清目标
          // 发现背景：猫直线移动无视地形，可能停在水中央 → 小人无限追、每 pathCd 重寻路，
          // huntCombat 每帧空转 → 200s 局 wall 88s（behavior 11ms/帧）。超时兜底防死循环。
          // （2026-08-14 更新：25s → 45s——猫刷在营地 15-40 环带，平均 27 格，步行
          //   1 格/s 追 27-42s 超过 25s 超时 → 目标永远被清、猎杀永远不发生。）
          st.huntElapsed = (st.huntElapsed ?? 0) + dt;
          if (st.huntElapsed > 45) {
            st.huntTarget = undefined;
            st.huntElapsed = 0;
            st.huntScanCd = 5;
            st.job = '闲逛';
            continue;
          }
          // 走到近旁才开始攻击（meleeRange 内）
          if (Math.hypot(pos.x - t.x, pos.y - t.y) > 2.2) continue;
          st.huntElapsed = 0;
          // 找该位置的猫（hostiles 按坐标匹配最近一只）
          let hit: number = -1;
          for (let i = 0; i < sim.hostiles.length; i++) {
            const h = sim.hostiles[i];
            if (Math.hypot(h.x - t.x, h.y - t.y) < 2.5) { hit = i; break; }
          }
          if (hit < 0) { st.huntTarget = undefined; st.job = '闲逛'; continue; }
          const h = sim.hostiles[hit];
          // 猎杀伤害：基础 + fight 技能加成（COC：fight 越高越快猎杀）
          const skill = st.skills?.fight ?? 10;
          h.hp -= (6 + skill * 0.15) * dt;
          // 技能成长节流（发现背景：每帧 growSkill → EWA 学习表更新开销大，
          // profile 实测 huntCombat 禁掉后 200s 局 88s→22.5s）
          if (!st.huntSkillCd || (st.huntSkillCd -= dt) <= 0) {
            sim.growSkill(eid, 'fight');
            st.huntSkillCd = 1;
          }
          if (h.hp <= 0) {
            sim.hostiles.splice(hit, 1);
            const loot = h.loot ?? { item: 'food', amount: 4 };
            if (loot.item === 'food') {
              st.inventory = { food: (st.inventory?.food ?? 0) + loot.amount }; // 猎物进个人口袋
            } else {
              sim.stockpile[loot.item] = (sim.stockpile[loot.item] ?? 0) + loot.amount;
            }
            sim.bus.emit({ type: 'resource_gained', eid, item: loot.item, amount: loot.amount });
            sim.recordOutcome(eid, 'fight', loot.amount);
            sim.logEvent(`🏹 #${eid} 猎杀了一只${h.name ?? '野猫'}，获得${loot.item === 'food' ? '肉' : loot.item}×${loot.amount}`);
            st.huntTarget = undefined;
            st.job = '闲逛';
          }
        }
      },
    }),
  });

  // 狩猎卡（work 系列）：白天且附近有猫才可选；fight 技能越高越愿意打。
  // 注意：谓词必须先于卡注册（cardFromDef 构建卡时即解析 when 谓词）
  // 发现背景：
  //   a) weight 5 / utilityFixed 25 与伐木同级 → 抽 3 张几乎进不了手牌，100 次决策 0 次狩猎；
  //   b) weight 15 又过高 → 全员扑猫出营地，夜里在野外无"天黑回营"逻辑 →
  //      nightDrain+trauma 静默崩溃（500s 局 5/6 崩，崩溃者距火 35-51 格）；
  //      → 最终：weight 7 + 白天约束（夜晚不追猫，猎人回营休息）
  m.registerPredicate('huntNearby', (c) => c.view.hostilesNearby?.(c.eid) ?? false);
  m.registerPredicate('huntIsDay', (c) => !(c.view.isNight?.() ?? false));
  m.registerCardDef({
    id: 'hunt', name: '狩猎', series: 'work', weight: 7,
    when: ['huntNearby', 'huntIsDay'],
    utilityFixed: 45,
    action: 'walkAndWork', workType: 'hunt', label: '狩猎',
    satisfies: [{ desire: 'wrath', amount: 1 }],
  });

  // 5) 采集侧重：食物采集产出提高（tuning 覆盖），人口上限放宽；
  //    猫对建筑的伤害调低（采集狩猎是游牧生活，营地是歇脚处不是要塞，
  //    且无 autobuild 重建，营地被拆即散落——猫主要威胁人而非建筑）
  //    理智：游牧民族耐受野外夜宿（nightDrain 大降 + 篝火安慰半径放大）。
  //    发现背景：hg 无 autobuild 第二篝火，远处工作的小人夜宿 7 格外持续流失理智；
  //    0.15/s 时 30 分钟局（30 夜）仍 8/11 人反复崩溃（恢复后再野外再崩循环）——
  //    游牧玩法野外过夜是常态，夜宿流失应远低于定居（0.05/s = 33 夜才崩）。
  //   （2026-08-14 更新）0.05/s 仍偏猛：30 分钟局快照 12/13 人崩溃中——崩溃者 60s
  //    才本能逃火（crazyFleeAfter），白天 60s 窗口内往往回不到火 → 恢复被推迟到下一天，
  //    夜间又在野外流失 → 跨夜累积雪球。下调 nightDrain 至 0.02（1.2 点/夜）同时
  //    crazyFleeAfter 60→15（崩溃者 15s 内回火，当天窗口内恢复），sanTraumaDrain
  //    0.03→0.01（崩溃者断食的创伤流失减半，避免"饿→创伤→更崩"滚雪球）。
  //   （2026-08-14 追加）根因不止数值：内核无"天黑回营"行为，小人野外过夜是常态
  //    （夜流失虽小但每日必发生）；补"夜归篝火"卡（见 5b）让夜晚工作的人回营。
  m.overrideTuning({
    gather: { harvestYield: 3.5 },
    population: { maxPawns: 10 },
    combat: { buildingDmg: 0.4 },
    san: { nightDrain: 0.02, fireComfortRadius: 9, crazyFleeAfter: 15 },
    needs: { sanTraumaDrain: 0.01 },
  });

  // 5b) 夜归篝火：夜晚 + 离营 → 高权重回营卡（work:camp 执行器：走到最近 campfire 旁）。
  //    发现背景：内核 behavior 无"天黑回营"行为，hg 小人野外就地过夜 →
  //    nightDrain + trauma 每日必崩 → 30 分钟局快照 12/13 崩溃（雪球）。
  //    回营是游牧玩法基石（夜宿篝火），作为 mod 卡补上，不动内核。
  m.registerPredicate('nightAway', (c) => {
    if (!(c.view.isNight?.() ?? false)) return false;
    // 距最近 campfire > 3 格 = 夜里还呆在野外，要回营（campfireDist 来自 view，-1 无火）
    const d = c.view.campfireDist?.(c.eid) ?? -1;
    return d > 3;
  });
  m.registerWork('camp', (c: SimContext, eid: number, st) => {
    const pos = c.pawnPositions.get(eid);
    if (!pos) return;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const [k, b] of c.world.buildings) {
      if (b.def.id !== 'campfire') continue;
      const { x, y } = World.keyToXY(k);
      const d = (x - pos.x) ** 2 + (y - pos.y) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
    if (!best) { st.job = '闲逛'; return; }
    // pathCd 节流中（刚寻过路）→ 不重试
    if ((st.pathCd ?? 0) > 0) return;
    st.job = '夜宿';
    c.moveAdjacent(eid, best.x, best.y);
  });
  m.registerCardDef({
    id: 'camp', name: '夜归篝火', series: 'work', weight: 80,
    when: ['nightAway'],
    utilityFixed: 100,
    action: 'walkAndWork', workType: 'camp', label: '夜归篝火',
    satisfies: [{ desire: 'sloth', amount: 1 }],
  });

  // 6) 营火自治：营地被拆 → 重建出生点 campfire；人口增长 → 营地环带补篝火
  //    （1 火 / 4 人，半径 4-9 随机空位，配 socialUnits.onCampfireBuilt 并入聚居）。
  //    发现背景：autobuild 卸载后无人加建篝火，人口 4→11 时仍只有 1 个火堆，
  //    fireComfortRadius=7 覆盖不到 → 外围 5 人夜宿离火 14-28 格，nightDrain 0.35/s
  //    连续几夜 san 清零 → 全员理智崩溃 → 乱跑死循环（600s 局 5/6 崩溃）。
  m.registerSystemDef({
    id: 'campRebuild', label: '营火自治', category: 'world', before: 'events',
    ctor: (sim) => {
      let acc = 0;
      const campfireAt = (b: { x: number; y: number }) =>
        sim.world.placeBuilding(b.x, b.y, 'campfire', 'auto');
      return {
        id: 'campRebuild',
        init: () => {},
        update(dt: number) {
          acc += dt;
          if (acc < 60) return;
          acc = 0;
          const cx = Math.floor(sim.world.width / 2);
          const cy = Math.floor(sim.world.height / 2);
          const camps: { x: number; y: number }[] = [];
          for (const [k, b] of sim.world.buildings) {
            if (b.def.id === 'campfire') camps.push(World.keyToXY(k));
          }
          // 出生点营火被拆且全图无火 → 重建（防鼠鼠散落成游牧）
          if (camps.length === 0 && (sim.stockpile.wood ?? 0) >= 10) {
            if (campfireAt({ x: cx, y: cy + 2 })) {
              sim.socialUnits.onCampfireBuilt(sim.world.buildKey(cx, cy + 2));
              sim.stockpile.wood = Math.max(0, (sim.stockpile.wood ?? 0) - 10);
              sim.logEvent('🔥 鼠鼠们在原营地重建了篝火');
            }
            return;
          }
          // 人口增长 → 营地环带补篝火（每 4 人 1 火）
          const need = Math.ceil(sim.pawnList.length / 4);
          if (camps.length >= need || (sim.stockpile.wood ?? 0) < 10) return;
          const ref = camps[0];
          for (let a = 0; a < 12; a++) {
            const r = 4 + Math.floor(sim.rng.next() * 6);
            const ang = sim.rng.next() * Math.PI * 2;
            const nx = Math.round(ref.x + Math.cos(ang) * r);
            const ny = Math.round(ref.y + Math.sin(ang) * r);
            if (!sim.world.inBounds(nx, ny)) continue;
            if (campfireAt({ x: nx, y: ny })) {
              sim.socialUnits.onCampfireBuilt(sim.world.buildKey(nx, ny));
              sim.stockpile.wood = Math.max(0, (sim.stockpile.wood ?? 0) - 10);
              sim.logEvent(`🔥 鼠鼠们添了一堆篝火（人口 ${sim.pawnList.length}，${camps.length + 1}/${need} 堆）`);
              break;
            }
          }
        },
      };
    },
  });
  }
};

// 默认导出 = 包对象（兼容 pack.ts loadRemote 的 default export 约定；旧式函数 mod 调用方已迁移）
export default hunterGathererPack;
