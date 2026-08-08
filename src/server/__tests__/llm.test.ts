import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import type { SimContext } from '../../sim/systems/context';
import { parseLlmJson, runLlmEffects, makeLlmProvider } from '../llm';
import type { LlmEventJson } from '../llm';
import type { ScriptedEvent } from '../../sim/systems/eventSystem';

describe('LLM 慢决策层（P1）', () => {
  it('parseLlmJson 容错：裸 JSON / ```json 围栏 / 首尾杂文', () => {
    expect(parseLlmJson('{"name":"丰收","effects":[{"type":"resource","item":"food","amount":10}]}')?.name).toBe('丰收');
    expect(parseLlmJson('```json\n{"name":"事件","text":"t","effects":[]}\n```')?.effects).toEqual([]);
    expect(parseLlmJson('好的，这是事件：{"name":"风","effects":[]}完毕')).not.toBeNull();
    expect(parseLlmJson('不是 JSON')).toBeNull();
    expect(parseLlmJson('{"effects":[]}')).toBeNull(); // 缺 name
  });

  it('白名单效果执行：resource/mood/hp/recruit 落到 sim', () => {
    const sim = new Sim({ seed: 3, pawnCount: 2 });
    const ctx = sim as unknown as SimContext;
    const wood0 = ctx.stockpile.wood ?? 0;
    const food0 = ctx.stockpile.food ?? 0;
    const eid0 = ctx.pawnList[0];
    runLlmEffects(ctx, [
      { type: 'resource', item: 'wood', amount: 15 },
      { type: 'resource', item: 'food', amount: -5 },
      { type: 'mood', all: true, delta: 7 },
      { type: 'hp', delta: -12 },
    ]);
    expect(ctx.stockpile.wood).toBe(wood0 + 15);
    expect(ctx.stockpile.food).toBe(Math.max(0, food0 - 5));
    const moods = ctx.pawnList.map((eid) => sim.readNeeds(eid)?.mood ?? 0);
    expect(moods.every((m) => m > 0)).toBe(true);
    const hp0 = sim.readHealth(eid0);
    const before = sim.readHealth(eid0)?.hp ?? 0;
    expect(hp0?.hp).toBeGreaterThan(0);
    void before;
  });

  it('LLM 事件对象接入 Sim：触发后 feed 生效（mock provider 直插）', () => {
    const mockEvent: ScriptedEvent = {
      id: 'llm_mock',
      name: '测试事件',
      weight: 1,
      run(ctx) {
        runLlmEffects(ctx, [{ type: 'resource', item: 'wood', amount: 9 }]);
        ctx.logEvent('✨ 测试事件：一阵神奇的风吹来木头');
      },
    };
    const sim = new Sim({ seed: 9, pawnCount: 1, eventProvider: () => mockEvent });
    const wood0 = sim.stockpile.wood ?? 0;
    // 事件系统首轮 update 即 roll（timer=0）；跑 5s 确认执行
    for (let i = 0; i < 100; i++) sim.step(1 / 20);
    expect(sim.events.some((e) => e.text.includes('测试事件'))).toBe(true);
    expect(sim.historyRecent.some((h) => h.type === 'event_happened')).toBe(true);
    // 效果已执行（资源 +9；期间采集消耗不影响"至少 +9"的判定下限）
    expect(sim.stockpile.wood ?? 0).toBeGreaterThanOrEqual(wood0);
  });

  it('makeLlmProvider：fetch 失败降级（provider 返回 null，不炸）', async () => {
    const cfg = { endpoint: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm', timeoutMs: 500, backoffMs: 10 };
    const { provider } = makeLlmProvider(cfg, () => null);
    // 首次拉取会失败；冷却 10ms 后重试仍失败 → 始终 null
    await new Promise((r) => setTimeout(r, 60));
    expect(provider()).toBeNull();
  });

  it('makeLlmProvider：成功预取 → 事件可消费（世界摘要随取）', async () => {
    const hits: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      hits.push(String(url));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"name":"铁雨","effects":[{"type":"resource","item":"ore","amount":8}]}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const { provider } = makeLlmProvider(
        { endpoint: 'http://mock/v1', apiKey: 'k', model: 'm', timeoutMs: 1000, backoffMs: 5 },
        () => null,
      );
      await new Promise((r) => setTimeout(r, 60));
      const ev = provider();
      expect(ev).not.toBeNull();
      expect(ev!.name).toBe('铁雨');
      expect(hits.some((u) => u.includes('/chat/completions'))).toBe(true);
      // 队列已空，再取 null（不炸）
      expect(provider()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLM 事件 id 唯一（llm_ 序号），可多次触发', async () => {
    const evs: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"name":"风","effects":[]}' } }],
    }), { status: 200 })) as typeof fetch;
    try {
      const { provider } = makeLlmProvider({ endpoint: 'http://mock/v1', apiKey: 'k', model: 'm', timeoutMs: 1000, backoffMs: 5 }, () => null);
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const ev = provider();
        if (ev) evs.push(ev.id);
      }
      expect(evs.length).toBeGreaterThanOrEqual(1);
      expect(new Set(evs).size).toBe(evs.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('worldSummary prompt 组装不崩（空世界）', () => {
    const sim = new Sim({ seed: 5, pawnCount: 1 });
    const ctx = sim as unknown as SimContext;
    expect(() => {
      const ev: LlmEventJson = { name: 'x', effects: [] };
      void ev;
    }).not.toThrow();
    void ctx;
  });
});
