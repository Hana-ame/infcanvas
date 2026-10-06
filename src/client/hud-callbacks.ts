/**
 * client/hud-callbacks.ts —— HUD 发出的玩家意图面（类型单独抽出）。
 *
 * 为什么独立成文件：HudCallbacks 是「玩家输入 → 模拟」的唯一通道（原则④）。
 * 抽出来让 hud.ts / hud/*.ts / 测试都能引用同一份契约，而不必互相 import 整个 Hud 类
 * （避免 hud.ts ↔ panels 循环依赖）。接口本身保持与旧版完全一致（不多不少）。
 */
export interface HudCallbacks {
  onPauseToggle(): boolean; // 返回暂停后的状态
  onSpeedCycle(): number; // 返回新速度
  onFollowToggle(): boolean;
  onNewWorld(): void;
  onSave(): void;
  onLoad(): void;
}