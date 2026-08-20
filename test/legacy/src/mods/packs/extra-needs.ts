// 需求 DLC 示例（2026-08-20）：卫生/娱乐/社交需求——验证数据驱动需求注册
// DLC 调 sim.registerNeed 注册新需求类型 → tickNeedsBatch 自动衰减 → 紧急标记
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

const CFG = {
  hygieneDecay: 0.05,     // 卫生每秒衰减
  hygieneUrgentAt: 15,    // 低于 15 = 紧急（需洗澡）
  entertainmentDecay: 0.08, // 娱乐每秒衰减
  entertainmentUrgentAt: 10, // 低于 10 = 紧急（需娱乐）
};

export const extraNeedsPack: ModPack = {
  id: 'extra-needs',
  requires: [],
  apply(m: ModRegistry): void {
    // 在 Sim 构造后注册需求（通过 hook 或直接注册）
    // registerNeed 在 Sim 构造时调用 → 但 ModPack.apply 在 Sim 构造前
    // 所以用 init hook 注册
    m.registerHook('step:before', ({ sim }) => {
      if (!(sim as { _needsRegistered?: boolean })._needsRegistered) {
        (sim as { _needsRegistered?: boolean })._needsRegistered = true;
        (sim as { registerNeed?: (def: { id: string; label: string; init: number; decay: number; urgentAt?: number }) => void }).registerNeed?.({
          id: 'hygiene', label: '卫生', init: 80, decay: CFG.hygieneDecay,
          urgentAt: CFG.hygieneUrgentAt,
        });
        (sim as { registerNeed?: (def: { id: string; label: string; init: number; decay: number; urgentAt?: number }) => void }).registerNeed?.({
          id: 'entertainment', label: '娱乐', init: 70, decay: CFG.entertainmentDecay,
          urgentAt: CFG.entertainmentUrgentAt,
        });
      }
    });
  },
};