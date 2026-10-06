/**
 * hud-panels.test.ts —— 面板体系的两个核心契约（R3-HUD）：
 *  1. **可扩展**：新面板只需 register()，不改 hud.ts 就能挂上（并自动进正确分区）。
 *  2. **每帧不重建 DOM**：key 不变 → 零 DOM 写入；key 变 → 只写那一个面板。
 *
 * 为什么必须在 node 环境测（而不是靠肉眼或 e2e）：第 2 条是**性能契约**，
 * 一旦被后来的改动破坏（比如有人"顺手"把 keyOf 换成 html 比对），
 * 症状是"游戏慢慢变卡"，没有任何单测会报警——所以把它变成会红的断言。
 *
 * 环境：自带极简 DOM 替身（面板只用到 createElement/appendChild/querySelector/
 * dataset/style/innerHTML），不引入 jsdom 依赖（node 20/22 都能跑）。
 */
import { describe, expect, it } from 'vitest';
import { PanelHost, barRow, esc, keyOf } from '../client/hud/panels';
import type { PanelDef } from '../client/hud/panels';
import type { WorldView } from '../client/view';

// ---------------------------------------------------------------------
// 极简 DOM 替身：只实现 PanelHost 用到的那几个接口
// ---------------------------------------------------------------------
class FakeEl {
  children: FakeEl[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  innerHTML = '';
  parent: FakeEl | null = null;
  constructor(public tag = 'div', public className = '', public textContent = '', public id = '') {}
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  querySelector(sel: string): FakeEl | null {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      const walk = (n: FakeEl): FakeEl | null => {
        if (n.id === id) return n;
        for (const c of n.children) {
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(this);
    }
    return null;
  }
  /** 面板体里实际被写入过的 HTML 快照（差分测试用它确认"没有重写"） */
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      const r = c.find(pred);
      if (r) return r;
    }
    return null;
  }
  countAll(pred: (e: FakeEl) => boolean): number {
    let n = pred(this) ? 1 : 0;
    for (const c of this.children) n += c.countAll(pred);
    return n;
  }
}

function installFakeDom(): void {
  const g = globalThis as unknown as { document?: unknown };
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    body: new FakeEl('body'),
  };
}

/** 假 WorldView：面板只用到 colony()/events()/techProgress()，其余给空实现 */
function fakeView(over: Partial<{ pawnCount: number; time: number }> = {}): WorldView {
  return {
    time: over.time ?? 0,
    stockpile: {},
    events: () => [],
    pawns: () => [],
    hostiles: () => [],
    buildings: () => [],
    buildingDef: () => undefined,
    tuning: {} as WorldView['tuning'],
    traitName: (t: string) => t,
    tileAt: () => 'grass',
    featureAt: () => null,
    zAt: () => 0,
    inspect: () => {
      throw new Error('本测试不涉及地块信息');
    },
    techProgress: () => [],
    colony: () => ({
      pawnCount: over.pawnCount ?? 4,
      avgNeeds: { food: 50, rest: 50, mood: 50, san: 50 },
      avgHpPct: 100,
      buildingKinds: [],
      hostileCount: 0,
      raidPressure: null,
      raidEtaSec: null,
    }),
    inspectPawn: () => null,
    inspectBuilding: () => null,
    inspectHostile: () => null,
  };
}

/** 可变面板：测试用来驱动 key/显隐 变化 */
interface MutablePanel extends PanelDef {
  cur: { key: string; html: string; empty?: boolean };
}
function mutablePanel(id: string, slot: PanelDef['slot'] = 'vitals'): MutablePanel {
  const p: MutablePanel = {
    id,
    slot,
    cur: { key: 'k0', html: '<b>a</b>' },
    render() {
      return p.cur;
    },
  };
  return p;
}

describe('PanelHost 可扩展性（R3-HUD）', () => {
  it('register 后面板按 slot 固定顺序落进各自分区（不依赖注册顺序）', () => {
    installFakeDom();
    const root = new FakeEl('div');
    const host = new PanelHost(root as unknown as HTMLElement, 0);
    // 故意乱序注册：log 先、status 后
    host.register(mutablePanel('log', 'log'));
    host.register(mutablePanel('status', 'status'));
    host.register(mutablePanel('vitals', 'vitals'));

    expect(host.ids()).toEqual(['status', 'vitals', 'log']); // 按信息层级排序，与注册序无关
    host.refresh(fakeView(), true, 1000);
    const slots = root.children.map((c) => c.id);
    expect(slots).toEqual(['slot-status', 'slot-vitals', 'slot-log']);
  });

  it('重复 id 注册即抛错（静默覆盖会让"我的面板怎么没出现"极难排查）', () => {
    installFakeDom();
    const host = new PanelHost(new FakeEl() as unknown as HTMLElement, 0);
    host.register(mutablePanel('dup'));
    expect(() => host.register(mutablePanel('dup'))).toThrow(/面板已注册/);
  });

  it('外部玩法包可以只靠 register 增面板，无需改 hud.ts（本轮可扩展性的实质）', () => {
    installFakeDom();
    const root = new FakeEl('div');
    const host = new PanelHost(root as unknown as HTMLElement, 0);
    // 模拟"某个新玩法包在运行时挂自己的面板"
    host.register({ id: 'mod:weather', slot: 'threat', icon: '🌦', title: '天气', render: () => ({ key: 'w', html: '晴' }) });
    host.register(mutablePanel('status', 'status'));
    expect(host.ids()).toEqual(['status', 'mod:weather']); // 落在 threat 分区，排在 status 之后
    expect(host.refresh(fakeView(), true, 1000)).toBe(2); // 两个面板各写一次内容
    const weather = root.find((e) => e.dataset.pid === 'mod:weather');
    expect(weather).not.toBeNull();
    // 标题在 head 上（wrap 是容器，FakeEl 的 textContent 是逐元素的）
    const head = weather!.find((e) => e.className === 'panel-head')!;
    expect(head.textContent).toContain('天气');
    const body = weather!.find((e) => e.className === 'panel-body')!;
    expect(body.innerHTML).toContain('晴');
  });
});

describe('PanelHost 每帧差分：零 DOM 重建是硬契约（R3-HUD 性能）', () => {
  it('key 不变 → 返回 0 写入，且 innerHTML 一次都不被重写', () => {
    installFakeDom();
    const root = new FakeEl('div');
    const host = new PanelHost(root as unknown as HTMLElement, 0);
    const p = mutablePanel('a');
    host.register(p);

    // 首次挂载必然写一次（那是建节点，不是每帧成本）
    expect(host.refresh(fakeView(), true, 1000)).toBe(1);

    // 然后模拟 60 帧：数据完全不变（最常见的稳态情况）——应为零 DOM 操作
    let writes = 0;
    for (let f = 1; f < 61; f++) writes += host.refresh(fakeView(), false, 1000 + f * 16);
    expect(writes).toBe(0); // 60 帧零 DOM 操作

    // 关键：body.innerHTML 不能被重新赋值过（不只是"值相同"）。
    // 手法：写入一个哨兵后再刷新，若框架重写了 innerHTML 哨兵会被抹掉。
    const body = root.find((e) => e.dataset.pid === 'a')!.find((e) => e.className === 'panel-body')!;
    body.innerHTML = '<b>a</b><i id="sentinel"></i>';
    host.refresh(fakeView(), false, 5000);
    host.refresh(fakeView(), false, 5100);
    expect(body.innerHTML).toContain('sentinel'); // 没被重写 → 哨兵存活
  });

  it('key 变化 → 只写变化的那一个面板（其他面板零写入）', () => {
    installFakeDom();
    const root = new FakeEl('div');
    const host = new PanelHost(root as unknown as HTMLElement, 0);
    const a = mutablePanel('a');
    const b = mutablePanel('b');
    host.register(a);
    host.register(b);
    host.refresh(fakeView(), true, 1000);
    expect(host.lastWrites).toBe(2);

    a.cur = { key: 'k1', html: '<b>changed</b>' };
    expect(host.refresh(fakeView(), false, 1100)).toBe(1); // 只写 a
    expect(host.lastToggles).toBe(0); // 显隐没翻，不产生额外 DOM 操作
    const bodyA = root.find((e) => e.dataset.pid === 'a')!.find((e) => e.className === 'panel-body')!;
    expect(bodyA.innerHTML).toContain('changed');
    const bodyB = root.find((e) => e.dataset.pid === 'b')!.find((e) => e.className === 'panel-body')!;
    expect(bodyB.innerHTML).toBe('<b>a</b>'); // b 一次都没被重写
  });

  it('节流：minIntervalMs 内即使 key 变了也先不写（数据变了最迟 100ms 内显示）', () => {
    installFakeDom();
    const root = new FakeEl('div');
    const host = new PanelHost(root as unknown as HTMLElement, 100);
    const p = mutablePanel('a');
    host.register(p);
    host.refresh(fakeView(), true, 1000);
    expect(host.lastWrites).toBe(1);

    p.cur = { key: 'k1', html: 'x' };
    expect(host.refresh(fakeView(), false, 1050)).toBe(0); // 距上次 50ms < 100ms → 节流
    expect(host.refresh(fakeView(), false, 1100)).toBe(0); // 距上次 100ms，仍在窗内（严格小于判断）
    expect(host.refresh(fakeView(), false, 1200)).toBe(1); // 超过窗内 → 写
  });

  it('force=true 跳过节流（玩家交互后必须立刻有反馈）', () => {
    installFakeDom();
    const root = new FakeEl('div');
    const host = new PanelHost(root as unknown as HTMLElement, 100);
    const p = mutablePanel('a');
    host.register(p);
    host.refresh(fakeView(), true, 1000);
    p.cur = { key: 'k1', html: 'x' };
    expect(host.refresh(fakeView(), true, 1001)).toBe(1); // 强制：不等节流
  });

  it('empty 翻转会更新显隐，但只在翻转那一帧写 DOM', () => {
    installFakeDom();
    const root = new FakeEl('div');
    const host = new PanelHost(root as unknown as HTMLElement, 0);
    const p = mutablePanel('a');
    host.register(p);

    p.cur = { key: 'e', html: '', empty: true };
    host.refresh(fakeView(), true, 1000);
    const wrap = root.find((e) => e.dataset.pid === 'a')!;
    expect(wrap.style.display).toBe('none');

    // 内容不变、显隐也不变 → 零写入
    expect(host.refresh(fakeView(), false, 1010)).toBe(0);
    expect(wrap.style.display).toBe('none');

    // 显隐翻转 → 写
    p.cur = { key: 'n', html: '<b>有内容</b>', empty: false };
    host.refresh(fakeView(), false, 1020);
    expect(wrap.style.display).toBe('');
  });
});

describe('HUD 文案工具', () => {
  it('esc 转义尖括号/引号/&（mod 内容会带这些字符）', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a&b')).toBe('a&amp;b');
    expect(esc('说"话"')).toBe('说&quot;话&quot;');
  });

  it('barRow 生成稳定的进度条 HTML，数值钳制在 0..100', () => {
    const h = barRow('食', 120, '#fff');
    expect(h).toContain('width:100%');
    expect(barRow('食', -5, '#fff')).toContain('width:0%');
    expect(barRow('食', 50, '#fff')).toContain('width:50%');
  });

  it('keyOf 产生稳定 key，数组长度变化体现在 key 里', () => {
    expect(keyOf(1, 'a')).toBe('1|a');
    // keyOf 是**变参**（逐个标量传入），不是收数组——面板里就是这么用的
    expect(keyOf('1,2')).toBe('1,2');
    expect(keyOf()).toBe(''); // 空参 = 空 key
    expect(keyOf('1,2')).not.toBe(keyOf('1,2,3'));
  });
});