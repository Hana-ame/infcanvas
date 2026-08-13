// 科技表（抽卡解锁）—— 科技 = 解锁建造/玩法能力
// ⚠️ 注意：以下具体科技条目（玩具工艺/取水术/木屋营造…）是实验分支的占位示例，
// 用户未指定具体科技内容（用户只给机制：科技抽卡解锁 + 新科技初始只有娱乐可命中 + 权重渐进）。
// 真正的科技树内容待用户定义后再定稿。
// 机制（用户 2026-08-13 定案）：科技独立抽卡池解锁；解锁的建筑初始只有娱乐（探索卡）能抽到
// 建造意图，随解锁时长建造权重渐进爬升（techBuildWeight 0→1）。
export interface TechDef {
  id: string;
  name: string;      // 科技名（卡面/UI 显示）
  unlocks: string[]; // 解锁的建筑 defId
  desc: string;      // 一句话说明
}

// 顺序即抽卡解锁顺序（越靠后越高级，"往后抽卡" = 后期才抽到高级科技）
// 科技表（消费方：sim.unlockTech 解锁 + BuildingDef.tech 门控建造；
// 抽卡端 makeDummyCardPlanner/LLM 版都按 TECH_ORDER 顺序抽，抽到即解锁）
export const TECHS: Record<string, TechDef> = {
  // 实验分支（feature/colony-survival-dims）：初始科技只提供娱乐属性（玩具）——
  // 模拟探索式开局：先有娱乐，取水/房屋等生存设施需后续科技解锁，验证殖民地能否存续
  toyTech: { id: 'toyTech', name: '玩具工艺', unlocks: ['toy'], desc: '制作玩具：提供娱乐设施' },
  wellTech: { id: 'wellTech', name: '取水术', unlocks: ['well'], desc: '挖水井：营地持续取水' },
  houseTech: { id: 'houseTech', name: '木屋营造', unlocks: ['house'], desc: '建造房屋：提供庇护与休息' },
  raftTech: { id: 'raftTech', name: '竹筏工艺', unlocks: ['raft'], desc: '水面搭建竹筏：渡水捕鱼' },
  bridgeTech: { id: 'bridgeTech', name: '桥梁工程', unlocks: ['bridge'], desc: '水上修桥：把水面铺成可通行的桥面' },
  boatTech: { id: 'boatTech', name: '造船术', unlocks: ['boat'], desc: '建造渡船：大型水上平台' },
};

export const TECH_ORDER: string[] = Object.keys(TECHS);
