// 社交对话模板表（数据驱动：文本层）
// 微互动模板（greet/positive/negative）+ 流言话题模板（历史事件 → 话题文案）
// 话题 text 为函数（机制）：按事件数据生成文案；返回 null = 该记录不产话题
// mod 可 registerLine / registerTopicTemplate 扩展（跨 Sim 实例共享，同谓词/权重规则策略）
export interface TopicTemplate {
  event: string; // 历史记录 type（historyQuery 返回）
  text: (data: Record<string, unknown>) => string | null;
}

export interface SocialLineTable {
  greet: string[];
  positive: string[];
  negative: string[];
  topics: TopicTemplate[];
}

export const SOCIAL_LINES: SocialLineTable = {
  greet: ['打个招呼', '点头致意', '打了个哈欠', '抱怨天气', '交换了个眼神', '小声嘀咕'],
  positive: ['夸了你', '分享了口粮', '拍了拍你的肩', '讲了个笑话'],
  negative: ['瞪了你一眼', '说了句风凉话', '背着你偷笑', '嫌弃地走开'],
  topics: [
    { event: 'work_completed', text: (d) => `说他昨天${d.success ? '干成了' : '没干成'}一单活` },
    { event: 'pawn_died', text: () => '议论昨天死的那个' },
    { event: 'raid_started', text: () => '聊起野猫袭击的事' },
    { event: 'building_built', text: (d) => `说新盖了个${d.defId}` },
    { event: 'resource_gained', text: (d) => `说他攒了点${d.item}` },
  ],
};
