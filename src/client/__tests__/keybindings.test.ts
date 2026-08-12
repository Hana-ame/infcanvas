import { describe, it, expect, beforeEach } from 'vitest';
import { Keybindings, normalizeKey, keyOfEvent } from '../keybindings';

// 内存存储（隔离 localStorage）
function memStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

const ev = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods }) as KeyboardEvent;

describe('keybindings 改键系统', () => {
  let kb: Keybindings;
  let store: ReturnType<typeof memStorage>;

  beforeEach(() => {
    store = memStorage();
    kb = new Keybindings(store);
  });

  it('归一化：Space 特判、字母小写', () => {
    expect(normalizeKey(' ')).toBe('Space');
    expect(normalizeKey('B')).toBe('b');
    expect(normalizeKey('b')).toBe('b');
    expect(normalizeKey('Escape')).toBe('Escape');
  });

  it('默认键位：pause=Space，buildWall=b', () => {
    expect(kb.getKeys('pause')).toContain('Space');
    expect(kb.getKeys('buildWall')).toContain('b');
    expect(kb.actionFor(ev(' '))).toBe('pause');
    expect(kb.actionFor(ev('b'))).toBe('buildWall');
  });

  it('命中规则：小写归一化命中（Shift+B → buildWall），带修饰键不命中', () => {
    expect(kb.actionFor(ev('B'))).toBe('buildWall');
    expect(kb.actionFor(ev('1'))).toBe('speed1');
    expect(kb.actionFor(ev('1', { ctrlKey: true }))).toBeNull();
    expect(kb.actionFor(ev('1', { altKey: true }))).toBeNull();
    expect(kb.actionFor(ev('x'))).toBeNull(); // 未绑定键不响应
  });

  it('bind 冲突消除：改到别的动作的键，原动作自动释放', () => {
    kb.bind('pause', 'p');
    expect(kb.actionFor(ev('p'))).toBe('pause');
    // p 无冲突。再绑：把 speed1 的 1 改给 pause → speed1 失去 1
    kb.bind('pause', '1');
    expect(kb.actionFor(ev('1'))).toBe('pause');
    expect(kb.getKeys('speed1')).not.toContain('1');
  });

  it('bind 幂等：同一键重复绑同一动作不重复', () => {
    kb.bind('pause', 'Space');
    kb.bind('pause', 'Space');
    expect(kb.getKeys('pause').filter((k) => k === 'Space').length).toBe(1);
  });

  it('unbind 移除单个键', () => {
    kb.unbind('zoomIn', 'PageUp');
    expect(kb.getKeys('zoomIn')).not.toContain('PageUp');
    expect(kb.getKeys('zoomIn')).toContain('=');
  });

  it('持久化：改动写入存储；新实例读取一致（改键即时生效语义）', () => {
    kb.bind('pause', 'p');
    const kb2 = new Keybindings(store);
    expect(kb2.actionFor(ev('p'))).toBe('pause');
    expect(kb2.actionFor(ev(' '))).toBe('pause'); // bind 是追加，默认键保留
  });

  it('损坏存储回退默认', () => {
    store.setItem('infcanvas.keymap', '{broken json');
    const kb2 = new Keybindings(store);
    expect(kb2.actionFor(ev(' '))).toBe('pause');
  });

  it('reset 恢复默认并持久化', () => {
    kb.bind('pause', 'p');
    kb.reset();
    expect(kb.actionFor(ev(' '))).toBe('pause');
    expect(kb.actionFor(ev('p'))).toBeNull();
    const kb2 = new Keybindings(store);
    expect(kb2.actionFor(ev(' '))).toBe('pause');
  });

  it('onChange 订阅：bind/unbind/reset 均触发', () => {
    let n = 0;
    kb.onChange(() => n++);
    kb.bind('pause', 'p');
    kb.unbind('pause', 'p');
    kb.reset();
    expect(n).toBe(3);
  });
});
