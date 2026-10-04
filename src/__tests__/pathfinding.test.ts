/**
 * pathfinding.test.ts —— A*：直线路径 / 绕障 / 斜角禁切 / 小数起点量化 / 不可达 /
 * 预算上限 / z 高差与攀爬门控。
 */
import { describe, expect, it } from 'vitest';
import { findPath, PATHFINDER_VERSION } from '../sim/pathfinding';

const open = (_x?: number, _y?: number) => true;
const pass = (x: number, y: number) => open(x, y);
const stepPass = (_fx: number, _fy: number, tx: number, ty: number) => pass(tx, ty);

describe('A* 寻路', () => {
  it('实现哨兵：PATHFINDER_VERSION ≥ 2（转换缓存陈旧立刻暴露）', () => {
    expect(PATHFINDER_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('平地直线：返回不含起点的相邻步进序列', () => {
    const path = findPath(stepPass, pass, 0, 0, 3, 0, 100);
    expect(path[0]).toEqual({ x: 1, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 3, y: 0 });
    expect(path).toHaveLength(3);
  });

  it('对角线：8 邻域走斜线（比 4 邻域 L 形短）', () => {
    const path = findPath(stepPass, pass, 0, 0, 2, 2, 100);
    expect(path).toHaveLength(2);
    expect(path[1]).toEqual({ x: 2, y: 2 });
  });

  /** 步进合法性：切比雪夫距离 1；对角步的两个正交邻格必须可走（斜角禁切） */
  function assertLegalPath(
    path: { x: number; y: number }[],
    ok: (fx: number, fy: number, tx: number, ty: number) => boolean,
    sx: number,
    sy: number,
  ): void {
    let cx = sx;
    let cy = sy;
    for (const s of path) {
      const dx = Math.abs(s.x - cx);
      const dy = Math.abs(s.y - cy);
      expect(Math.max(dx, dy)).toBe(1);
      if (dx === 1 && dy === 1) {
        expect(ok(cx, cy, cx + (s.x - cx), cy)).toBe(true);
        expect(ok(cx, cy, cx, cy + (s.y - cy))).toBe(true);
      }
      [cx, cy] = [s.x, s.y];
    }
  }

  it('绕开水墙：仍能到达且每一步合法', () => {
    const passable = (x: number, y: number) => !(x === 2 && Math.abs(y) <= 5);
    const path = findPath(passable, passable, 0, 0, 4, 0, 500);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ x: 4, y: 0 });
    assertLegalPath(path, passable, 0, 0);
  });

  it('小数起点：量化到所在格后正常寻路（连续坐标直接喂 A* 曾整条返回空）', () => {
    const a = findPath(stepPass, pass, 0.4, 0.4, 3, 3, 500);
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(a[a.length - 1]).toEqual({ x: 3, y: 3 });
    assertLegalPath(a, open, 0, 0);
    const b = findPath(stepPass, pass, 2.6, 3.1, 5, 3, 500);
    expect(b[b.length - 1]).toEqual({ x: 5, y: 3 });
    assertLegalPath(b, open, 3, 3);
  });

  it('斜角禁切：两面正交墙的夹缝不可穿越，须绕行', () => {
    // 谓词是"按边"4 参语义（与生产 setPath 同构）——2 参写法只会判出发格，
    // 墙形同虚设（本次实测踩坑：测试谓词签名没跟上 z 重构）
    const wall = (x: number, y: number) => (x === 1 && y === 0) || (x === 0 && y === 1);
    const stepOk = (_fx: number, _fy: number, tx: number, ty: number) => !wall(tx, ty);
    const goalOk = (x: number, y: number) => !wall(x, y);
    const path = findPath(stepOk, goalOk, 0, 0, 1, 1, 500);
    expect(path.length).toBeGreaterThan(1); // 禁切后不可能一步对角直达
    assertLegalPath(path, stepOk, 0, 0);
    expect(path[path.length - 1]).toEqual({ x: 1, y: 1 });
  });

  it('被环形围墙围死 → 空路径', () => {
    const walled = (x: number, y: number) => Math.max(Math.abs(x), Math.abs(y)) !== 5;
    const stepOk = (_fx: number, _fy: number, tx: number, ty: number) => walled(tx, ty);
    expect(findPath(stepOk, walled, 0, 0, 9, 9, 2000)).toHaveLength(0);
    expect(findPath(stepOk, walled, 0, 0, 3, 3, 2000)).not.toHaveLength(0);
  });

  it('迭代预算耗尽 → 空路径（双档上限的"快速失败"语义）', () => {
    expect(findPath(stepPass, pass, 0, 0, 300, 300, 10)).toHaveLength(0);
  });

  it('终点不可立足 → 直接不可达', () => {
    const path = findPath(stepPass, (x) => x !== 5, 0, 0, 5, 0, 1000);
    expect(path).toHaveLength(0);
  });

  // ---- z 高度模型 ----
  /** x≥3 是 z=2 的岩层高台，其余 z=0；stepOk 按 |Δz|≤climb 判边 */
  function plateauWorld(climb: number) {
    const zAt = (x: number) => (x >= 3 ? 2 : 0);
    const stepOk = (fx: number, _fy: number, tx: number, _ty: number) =>
      Math.abs(zAt(tx) - zAt(fx)) <= climb;
    return { stepOk };
  }

  it('z 高差门控：攀爬 1 上不去岩层高台；攀爬 2 可以', () => {
    const low = plateauWorld(1);
    expect(findPath(low.stepOk, open, 0, 0, 5, 0, 2000)).toHaveLength(0); // 鼠：上不去
    const high = plateauWorld(2);
    const path = findPath(high.stepOk, open, 0, 0, 5, 0, 2000); // 攀爬 2：可登台
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ x: 5, y: 0 });
  });

  it('z 起点量化：站在半格上以所在格海拔参与判定', () => {
    const { stepOk } = plateauWorld(1);
    // 起点 x=2.6 → 取整 (3)：已在岩层上 → 到 (5,0) 全程 Δz=0，畅通
    const path = findPath(stepOk, open, 2.6, 0, 5, 0, 2000);
    expect(path.length).toBeGreaterThan(0);
    // 起点 x=0.6 → 取整 (1)：z=0 → 依旧上不去
    expect(findPath(stepOk, open, 0.6, 0, 5, 0, 2000)).toHaveLength(0);
  });
});
