// 自定义改键系统
//  - 动作表 + 默认键位（每动作支持多键）
//  - 绑定冲突自动消除（同一键只能属一个动作）
//  - localStorage 持久化（可选存储实现，测试可注入内存版）
//  - 归一化：e.key 小写字母统一（Shift+B → 'b'），Space 特判 ' ' → 'Space'
export const ACTIONS = {
  pause: '暂停/继续',
  speed1: '速度 1x',
  speed2: '速度 2x',
  speed3: '速度 3x',
  zoomIn: '放大',
  zoomOut: '缩小',
  cancel: '取消 / 退出建造',
  buildWall: '建造墙',
  viewToggle: '视角切换',
  helpToggle: '帮助面板',
  historyToggle: '历史面板',
  factionToggle: '派系面板',
  techsToggle: '科技面板',
  menuFold: '建造菜单折叠',
} as const;
export type ActionId = keyof typeof ACTIONS;

const DEFAULT_KEYMAP: Record<ActionId, string[]> = {
  pause: ['Space'],
  speed1: ['1'],
  speed2: ['2'],
  speed3: ['3'],
  zoomIn: ['PageUp', '='],
  zoomOut: ['PageDown', '-'],
  cancel: ['Escape'],
  buildWall: ['b'],
  viewToggle: ['v'],
  helpToggle: ['h'],
  historyToggle: ['t'],
  factionToggle: ['g'],
  techsToggle: ['y'],
  menuFold: ['m'],
};

const STORAGE_KEY = 'infcanvas.keymap';

// 归一化按键标识（用于匹配与展示）
export function normalizeKey(k: string): string {
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toLowerCase();
  return k;
}

export function keyOfEvent(e: KeyboardEvent): string {
  return normalizeKey(e.key);
}

export class Keybindings {
  private map: Record<string, string[]>;
  private onChangeCbs: (() => void)[] = [];
  private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null) {
    this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null) ?? {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    this.map = this.load();
  }

  private load(): Record<string, string[]> {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_KEYMAP);
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      // 与默认合并：新增动作自动带默认键，缺失动作不残留
      const merged: Record<string, string[]> = {};
      for (const [id, keys] of Object.entries(DEFAULT_KEYMAP)) {
        const saved = parsed[id];
        merged[id] = Array.isArray(saved) && saved.length > 0 ? saved : keys;
      }
      return merged;
    } catch {
      return structuredClone(DEFAULT_KEYMAP);
    }
  }

  private save(): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.map));
  }

  getKeys(action: ActionId): string[] {
    return this.map[action] ?? [];
  }

  // 显示用（键 → 友好名）
  displayKey(k: string): string {
    const names: Record<string, string> = {
      Space: '空格', Escape: 'Esc', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    };
    return names[k] ?? k;
  }

  // 绑定单个键到动作（追加语义：同动作可绑多键，追加不覆盖）；冲突键自动从其他动作移除（一键只属一动作）
  bind(action: ActionId, key: string): void {
    const k = normalizeKey(key);
    for (const [id, keys] of Object.entries(this.map)) {
      const i = keys.indexOf(k);
      if (i >= 0 && id !== action) keys.splice(i, 1);
    }
    const list = this.map[action] ?? (this.map[action] = []);
    if (!list.includes(k)) list.push(k);
    this.save();
    this.emit();
  }

  unbind(action: ActionId, key: string): void {
    const k = normalizeKey(key);
    const list = this.map[action];
    if (!list) return;
    const i = list.indexOf(k);
    if (i >= 0) list.splice(i, 1);
    this.save();
    this.emit();
  }

  reset(): void {
    this.map = structuredClone(DEFAULT_KEYMAP);
    this.save();
    this.emit();
  }

  // 事件 → 命中动作（无修饰键的纯按键，首个匹配）
  actionFor(e: KeyboardEvent): ActionId | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    const k = keyOfEvent(e);
    for (const id of Object.keys(this.map) as ActionId[]) {
      if (this.map[id].includes(k)) return id;
    }
    return null;
  }

  onChange(cb: () => void): void {
    this.onChangeCbs.push(cb);
  }

  private emit(): void {
    for (const cb of this.onChangeCbs) cb();
  }
}

export const keybindings = new Keybindings();
