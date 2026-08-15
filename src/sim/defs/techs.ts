// 科技表（碎片抽卡解锁）—— 科技 = 解锁建造/玩法能力
// ⚠️ 注意：以下具体科技条目（玩具工艺/取水术/木屋营造…）是实验分支的占位示例，
// 用户未指定具体科技内容（用户只给机制：科技抽卡解锁 + 新科技初始只有娱乐可命中 + 权重渐进）。
// 真正的科技树内容待用户定义后再定稿。
// 机制（用户 2026-08-13 定案）：科技独立抽卡池解锁；解锁的建筑初始只有娱乐（探索卡）能抽到
// 建造意图，随解锁时长建造权重渐进爬升（techBuildWeight 0→1）。
// 碎片制（用户 2026-08-14 追加定案）："每个科技都有碎片，碎片攒齐了才能组成科技，也是抽卡"——
// 科技抽卡池每抽给一块碎片（按 TECH_ORDER 顺序渐进加权），攒满 fragments 块自动解锁整卡。
export interface TechDef {
  id: string;
  name: string;      // 科技名（卡面/UI 显示）
  unlocks: string[]; // 解锁的建筑 defId
  desc: string;      // 一句话说明
  fragments?: number; // 攒齐所需碎片数（2026-08-14 碎片制）；缺省 1 = 抽到整卡直接解锁（mod/旧数据兼容）
}

// 顺序即抽卡解锁顺序（越靠后越高级，"往后抽卡" = 后期才抽到高级科技）
// 科技表（消费方：sim.unlockTech 解锁 + BuildingDef.tech 门控建造；
// 抽卡端 makeDummyCardPlanner/LLM 版都按 TECH_ORDER 顺序抽，抽到即解锁）
// 科技 id 命名规范：`<领域>:<内容>`（shelter:house / water:well / craft:toy / transport:raft…）
// —— 领域前缀便于扩展与 DLC：mod 注册 `registerTech`（或 defs.techs 声明）追加任意领域科技，
//    探索卡/权重/门控全自动接入（unlocks 建筑动态生成探索卡，无需改内核）
// fragments 数值（2026-08-14）：统一 3 块碎片组成一科技（首块约等于原整卡节奏的 1/3，
// 由 tuning.tech.poolInterval/poolChance 决定总体进度；mod 可用 overrideDef 覆写单科技碎片数）
export const TECHS: Record<string, TechDef> = {
  // 初始科技只提供娱乐属性（玩具）——模拟探索式开局：先有娱乐，取水/房屋等生存设施需后续科技
  'craft:toy': { id: 'craft:toy', name: '玩具工艺', unlocks: ['toy'], desc: '制作玩具：提供娱乐设施', fragments: 3 },
  'water:well': { id: 'water:well', name: '取水术', unlocks: ['well'], desc: '挖水井：营地持续取水', fragments: 3 },
  'shelter:house': { id: 'shelter:house', name: '木屋营造', unlocks: ['house'], desc: '建造房屋：昂贵庇护与休息', fragments: 3 },
  'shelter:cave': { id: 'shelter:cave', name: '洞穴改造', unlocks: ['caveHouse'], desc: '改造天然洞穴为居所：资源少', fragments: 3 },
  'transport:raft': { id: 'transport:raft', name: '竹筏工艺', unlocks: ['raft'], desc: '水面搭建竹筏：渡水捕鱼', fragments: 3 },
  'transport:bridge': { id: 'transport:bridge', name: '桥梁工程', unlocks: ['bridge'], desc: '水上修桥：把水面铺成可通行的桥面', fragments: 3 },
  'transport:boat': { id: 'transport:boat', name: '造船术', unlocks: ['boat'], desc: '建造渡船：大型水上平台', fragments: 3 },
};

// TECH_ORDER = 科技抽卡池顺序（rank 越靠前权重越高 = 越易抽到，"往后抽卡"渐进解锁）。
// 注意：TECHS 是模块级全局表（玩法包 registerTech 会追加 DLC 科技），TECH_ORDER 数组
// 由 registerTech 维护 push（2026-08-15 修复：此数组曾 = Object.keys(TECHS) 模块加载
// 快照——clothing 等玩法包注册的科技永远进不了抽卡池，制衣术 165 分钟 0 碎片。
// 重复可开出（用户 2026-08-15 裁决）：候选池含已解锁科技，抽到 = 重复卡碎片无效，
// 稀释新科技获取期望——故后续注册科技排在已解锁科技之后，抽卡权重天然偏低）。
export const TECH_ORDER: string[] = Object.keys(TECHS);
