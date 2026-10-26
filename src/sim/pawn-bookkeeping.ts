/**
 * pawn-bookkeeping.ts —— 每 tick 的全局鼠级记账（从 Sim.step 内联块抽出）。
 *
 * 内容：近战缠斗判定、蓄力出招推进、技能冷却、征召持握续期、连续作业疲劳
 * 与进度、心情崩溃。全部是 per-pawn 的逐 tick 簿记，**不读区块**，成本 O(鼠×敌)。
 *
 * 为什么单独成文件（不是留在 Sim.step 里）：Sim.step 与 Sim.stepChunked 必须
 * 共用**同一份实现**。两者的唯一合法差异是「系统是否按区块跳过」，其余要逐位
 * 等价（stepChunked 的 null=全量 路径得能对齐本地 step；见 chunked-server.test.ts
 * 的三条等价性用例）。两条路径各写一份拷贝必然分叉，所以只能是单一实现。
 *
 * 历史缺陷（2026-10-26 修）：这段原先只内联在 step() 里，stepChunked() 整段不跑。
 * 而服务器权威路径（game-server.ts 只调 stepChunked）因此从不推进它，后果：
 *   - attackWindup 永久停在 0 → 联机下 directAttack 的蓄力永不完成，后续伤害与
 *     atkCd 重置永不结算，客户端出招弧线（render-entities.ts）停在起点；
 *   - skills.cooldown 永不递减；activeWork.workContinuousSec 永不累积（作业疲劳与
 *     进度冻住）；p.drafted 的 holdUntil 永不续期；inMeleeGrapple 永远为 false。
 * 分片只跳系统里的空间密集型更新，不跳这段——跳了就会重新引入上面的分叉。
 */
import { enforceMaxThreeSkills } from './genetics-skills';
import { triggerColonistMentalBreak, type Sim } from './sim';

/** 推进全体鼠的逐 tick 簿记。由 Sim.step 与 Sim.stepChunked 共同调用。见文件头。 */
export function tickPawnBookkeeping(sim: Sim, dt: number): void {
  const hasHostiles = sim.hostilesList.length > 0;
  if (hasHostiles) {
    for (const h of sim.hostilesList) h.inMeleeGrapple = false;
  }
  for (const p of sim.pawnMap.values()) {
    if (p.skills) {
      if (p.skills.length > 3) p.skills = enforceMaxThreeSkills(p.skills);
      for (const sk of p.skills) {
        if (sk.cooldown > 0) sk.cooldown = Math.max(0, sk.cooldown - dt);
      }
    }
    if (p.drafted) p.holdUntil = sim.time + 10;
    if (sim.playerRimWorldMode && !p.isStranger && (p.needs.mood <= 10 || p.needs.san <= 10)) {
      triggerColonistMentalBreak(sim, p.eid, '长期心情极度低落');
      continue;
    }
    let grappled = false;
    if (hasHostiles) {
      for (const h of sim.hostilesList) {
        const dx = h.pos.x - p.pos.x;
        const dy = h.pos.y - p.pos.y;
        if (dx * dx + dy * dy <= 2.56) {
          grappled = true;
          h.inMeleeGrapple = true;
        }
      }
    }
    p.inMeleeGrapple = grappled;
    if (p.attackWindup !== undefined) {
      p.attackWindup += dt;
      p.path = [];
      if (p.attackWindup >= (p.attackWindupTotal ?? 0.8)) {
        if (p.attackTargetId !== undefined) {
          const target = sim.hostilesList.find((x) => x.id === p.attackTargetId);
          if (target) {
            const dmg = sim.tuning.pawn.dmg * (sim.tuning.pawn.traitDmgMul[p.trait] ?? 1);
            sim.damageHostile(target.id, Math.round(dmg));
            sim.log(`⚔ ${p.name} 蓄力出招命中敌军 #${target.id}！`);
          }
        }
        p.attackWindup = undefined;
        p.attackTargetId = undefined;
        p.atkCd = sim.tuning.pawn.atkCd;
      }
    }
    if (p.activeWork && p.activeWork.kind !== 'butcher' && p.activeWork.kind !== 'haul_corpse') {
      p.activeWork.workContinuousSec = (p.activeWork.workContinuousSec ?? 0) + dt;
      let fatigue = 1.0;
      if (p.activeWork.workContinuousSec > 10) {
        fatigue = Math.max(0.2, 1.0 - (p.activeWork.workContinuousSec - 10) * 0.035);
      }
      if (p.activeWork.workContinuousSec > 12 && sim.rng() < 0.15 * dt) {
        p.activeWork.workProgress = Math.max(0, p.activeWork.workProgress - 2.5 * dt);
      }
      p.activeWork.workProgress += dt * 12 * fatigue;
      if (p.activeWork.workProgress >= p.activeWork.workTotal) {
        p.activeWork = undefined;
      }
    }
  }
}
