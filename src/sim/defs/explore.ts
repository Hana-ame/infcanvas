// 探索卡（用户机制：科技建筑解锁初期只有娱乐卡能抽到建造意图——模拟探索）
// 注意：卡本身是通用机制；具体科技内容见 techs.ts 占位说明（toy/well/house 系实验示例）
// 权重渐进：解锁后 techBuildWeight 0→1 爬升，普通建造卡随权重接管（见 cardSystem.techBuildChance）
// 每个科技解锁建筑自动生成一张「探索」卡（leisure 系列）：
//   - 抽卡条件：该科技已解锁 且 营地还没有该建筑（when 谓词动态注册）
//   - 小人只有在"娱乐/探索"抽卡时才会抽到 → 去规划该建筑的蓝图（探索行为）
//   - 效果：蓝图入队（与神谕垦田令同机制），小人照常自主建造
// 效果：初始只有娱乐卡能"发现"水车/玩具/房屋——探索式获取新设施
import type { BehaviorCardDef } from '../ai/pawn';
import { TECHS } from './techs';

// 为科技解锁建筑生成探索卡（系列 leisure = 娱乐；satisfies 娱乐欲望 sloth）
export function makeExploreCard(buildingId: string, techId: string): BehaviorCardDef {
  return {
    id: `explore:${buildingId}`,
    name: `探索·${TECHS[techId]?.name ?? buildingId}`,
    series: 'leisure',
    weight: 8,
    when: [`hasTech-${techId}`, `noBuilding-${buildingId}`],
    utilityFixed: 40, // 娱乐语境下的探索冲动：抽到即可执行（高于其他娱乐卡，低于生存需求卡）
    action: 'explore',
    label: `探索:${buildingId}`, // label 机器可解析（执行器 split(':') 取建筑 id）；显示名用 name
    satisfies: [{ desire: 'sloth', amount: 1 }],
    reason: '娱乐时灵光一现：可以建这个',
  };
}

// 科技表 → 探索卡清单（每座科技建筑一张；toy/well/house/raft/bridge/boat…）
export function allExploreCards(): BehaviorCardDef[] {
  const cards: BehaviorCardDef[] = [];
  for (const [techId, tech] of Object.entries(TECHS)) {
    for (const b of tech.unlocks) cards.push(makeExploreCard(b, techId));
  }
  return cards;
}
