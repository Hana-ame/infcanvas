// 核心玩法包集合（2026-08-21 从零重写·最小可玩第一版）
// 每个包只做一件事；挂载序由 requires 拓扑自动拉齐。
import type { ModPack } from '../pack';
import { needsPack } from './needs';
import { behaviorPack } from './behavior';
import { gatherPack } from './gather';
import { buildPack } from './build';
import { raidPack } from './raid';

export const CORE_PACKS: ModPack[] = [needsPack, behaviorPack, gatherPack, buildPack, raidPack];

/** 默认玩法聚合包：挂它 = 挂全部核心包 */
export const defaultPlaystyle: ModPack = {
  id: 'default-playstyle',
  requires: CORE_PACKS.map((p) => p.id),
  apply() {},
};