// 疗伤动作（2026-08-16 架构优化：双疗伤路径收敛）
// 背景：cardSystem 内核 heal 卡（execHeal）与 medicine 玩法包 treat 卡执行器原为同构
// 复制——找 heal tag 篝火 → 设 healTarget + moveAdjacent 走过去；无篝火 → healing 原地
// 休养会话。行为语义在两处漂移会静默分叉（改一处另一处不变，测试只护各自路径），
// 故抽公共 helper 作唯一实现。跨包读写方清单见 contracts.ts 的
// pawn.healTarget / pawn.healing 契约条目（写：cardSystem/medicine/sim；读：
// gatherSystem/medicine/drafting/cardSystem）——本函数是"写"的唯一入口之一。
import type { SimContext } from './context';
import type { PawnState } from '../sim';

export const beginHeal = (c: SimContext, eid: number, st: PawnState): void => {
  const pos = c.readPosition(eid);
  if (!pos) return;
  // 找最近 heal tag 建筑（篝火/暖炉）作治疗点；allowNonPassable=true——建筑格本身
  // 不可走，目标是"走到它旁边"
  const fire = c.findNearest(
    pos,
    (x, y) => c.world.getBuilding(x, y)?.def.tags?.includes('heal') ?? false,
    true,
  );
  if (fire) {
    // 有篝火：锁定治疗点并走过去（walkAndWork 到达后由推进侧检定疗伤进度）
    st.healTarget = fire;
    c.moveAdjacent(eid, fire.x, fire.y);
  } else {
    // 无篝火则原地休养（healing 会话由 gatherSystem 推进回血）
    st.healing = { progress: 0 };
  }
};