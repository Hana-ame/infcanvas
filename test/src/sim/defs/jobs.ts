// 指派职业表（Q10 生产线）—— 职业 → 主导工作卡 + 标签（数据驱动，客户端共享）
export const JOBS: Record<string, { label: string; cardId: string }> = {
  lumberjack: { label: '伐木工', cardId: 'chop' },
  miner: { label: '矿工', cardId: 'mine' },
  farmer: { label: '农民', cardId: 'build' },   // 农田自动产粮，农民负责扩建/维护农田（build）
  crafter: { label: '工匠', cardId: 'build' },
  fisher: { label: '渔民', cardId: 'fish' },
};

// 职业 → 主导工作卡 id（派生，保持向后兼容的导出名）
export const JOB_CARD: Record<string, string> = Object.fromEntries(
  Object.entries(JOBS).map(([id, j]) => [id, j.cardId]),
);

// 职业中文名查询（fisher→渔民/hunter→猎人 等；UI 显示用）
export const jobLabelOf = (job: string): string => JOBS[job]?.label ?? job;