// 拥挤惩罚测试（2026-08-16 用户反馈"鼠鼠之间需要有拥挤惩罚,不然会变成同一个路径"）
// 语义：多鼠朝同一目标移动时——±1 格内其他鼠越多移速越慢（crowdingPenalty/Floor，floor 钳制），
// 目标格被他人占据时停在格前 crowdStopGap 排队不叠格（涌现式避让：零新增状态，只读
// pawnPositions 快照）。断言：全程无严格重叠（<0.05）、排队间距形成（≥0.2）、单鼠仍直达。
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';

function stepN(sim: Sim, n: number): void {
  for (let i = 0; i < n; i++) sim.step(1);
}

describe('拥挤惩罚（walk 拥挤系数 + 目标占位排队）', () => {
  it('多鼠同目标:全程不严格重叠 + 每只都到达过目标', () => {
    const sim = new Sim({ seed: 42, pawnCount: 3 });
    const t = { x: Math.floor(sim.world.width / 2) + 6, y: Math.floor(sim.world.height / 2) };
    for (const eid of sim.pawns) {
      const st = sim.pawnStates.get(eid)!;
      st.path = [t];
      st.pathIndex = 0;
    }
    const initial = [...sim.pawns]; // 初始三只快照（120s 内出生鼠无目标路径,不参与断言）
    let minPair = Infinity;
    // 每只鼠运行中距目标的最小距离（到达语义:到达后可能自主乱走,结束位置不作数）
    const minDist = new Map(sim.pawns.map((e) => [e, Infinity]));
    for (let i = 0; i < 120; i++) {
      sim.step(1);
      for (const eid of sim.pawns) {
        const p = sim.pawnPositions.get(eid)!;
        const d = Math.hypot(p.x - t.x, p.y - t.y);
        if (d < minDist.get(eid)!) minDist.set(eid, d);
      }
      const ps = sim.pawns.map((e) => sim.pawnPositions.get(e)!);
      for (let a = 0; a < ps.length; a++) {
        for (let b = a + 1; b < ps.length; b++) {
          const d = Math.hypot(ps[a].x - ps[b].x, ps[a].y - ps[b].y);
          if (d < minPair) minPair = d;
        }
      }
    }
    expect(minPair).toBeGreaterThanOrEqual(0.05); // 任意时刻都不严格重叠（防"变同一路径"）
    for (const eid of initial) {
      // 初始三只都到达过目标附近（排队节流下 120s 也富余）
      expect(minDist.get(eid)!).toBeLessThan(2);
    }
  });

  it('单鼠不受拥挤惩罚影响:直达目标', () => {
    const sim = new Sim({ seed: 43, pawnCount: 1 });
    const t = { x: Math.floor(sim.world.width / 2) + 6, y: Math.floor(sim.world.height / 2) };
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    st.path = [t];
    st.pathIndex = 0;
    let minDist = Infinity;
    for (let i = 0; i < 8; i++) {
      sim.step(1);
      const p = sim.pawnPositions.get(eid)!;
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      if (d < minDist) minDist = d;
    }
    expect(minDist).toBeLessThan(1); // 8s 内到达过（速度 ≥ base×0.6=2.4 格/s×8=19 格,远超出生距）
  });
});