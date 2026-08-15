// LLM 慢决策层网关（P1，DESIGN §6/§10）—— OpenAl 兼容 chat completions
// 原则：LLM 只印卡 + 触发事件（不进选择链路）；效果走白名单执行器，失败降级确定性
// 预取模型：后台拉取 → 事件队列缓存 → provider() 同步消费（EventSystem 同步 tick 不受阻）
import type { EventProvider, ScriptedEvent } from '../sim/systems/eventSystem';
import type { SimContext } from '../sim/systems/context';
import { TUNING } from '../sim/defs/tuning';
import { World } from '../sim/core/world';

export interface LlmConfig {
  endpoint: string;         // OpenAI 兼容 base，如 https://api.openai.com/v1
  apiKey: string;
  model: string;
  timeoutMs?: number;       // 默认 15s
  backoffMs?: number;       // 失败后冷却，默认 30s
  maxQueue?: number;        // 预取队列上限，默认 3
}

// LLM 输出 schema —— 效果白名单（安全边界：不改 sim 内核，只做定义内操作）
export type LlmEffect =
  | { type: 'resource'; item: string; amount: number }   // 库存增减（food/wood/ore/tools）
  | { type: 'mood'; all?: boolean; delta: number }        // 全体/随机一名心情
  | { type: 'hp'; all?: boolean; delta: number }          // 全体/随机一名生命
  | { type: 'recruit' }                                   // 流浪者加入（营地处生成）
  | { type: 'log'; text: string };                        // 额外叙述（进 feed）

export interface LlmEventJson {
  name: string;       // 事件名（feed 标题）
  text?: string;      // 叙述
  effects: LlmEffect[];
}

// 世界摘要（user 消息）：把当前局面喂给 LLM，让它生成合乎情境的事件
function buildWorldPrompt(ctx: SimContext): string {
  const s = ctx.stockpile;
  // 2026-08-14 重构：派系 = 涌现展示，LLM 上下文给篝火记忆 + 归属人数
  const byFire = new Map<number, number[]>();
  for (const eid of ctx.pawnList) {
    const fireId = ctx.pawnStates.get(eid)?.fireId;
    if (fireId != null) {
      const arr = byFire.get(fireId) ?? [];
      arr.push(eid);
      byFire.set(fireId, arr);
    }
  }
  const mem = [...byFire.entries()]
    .map(([key, members]) => `营地@(${World.keyToXY(key).x},${World.keyToXY(key).y}) ${members.length}人`)
    .join('；');
  return [
    `第 ${Math.floor(ctx.time / ctx.dayLength) + 1} 天，时间 ${Math.floor(ctx.time / 60)} 分，${ctx.isNight() ? '夜晚' : '白天'}，${ctx.env.raining ? '下雨' : '晴朗'} ${Math.round(ctx.env.temperature)}°C。`,
    `库存：🌲木 ${s.wood ?? 0} 🪨矿 ${s.ore ?? 0} 🍖食物 ${s.food ?? 0} 🛠️ ${s.tools ?? 0}`,
    `人口 ${ctx.pawnList.length}，建筑 ${ctx.world.buildings.size} 座（含 ${[...ctx.world.buildings.values()].map((b) => b.def.name).slice(0, 6).join('、')}）。`,
    byFire.size > 0 ? `聚居：${mem}` : '尚无营地归属。',
  ].join('\n');
}

const SYSTEM_PROMPT = [
  '你是殖民地模拟器的事件导演。根据玩家世界的现状生成一个合适的随机事件。',
  '只输出 JSON，不要任何解释。格式：',
  '{"name":"事件名(10字内)","text":"一句叙述(30字内)","effects":[{"type":"resource","item":"wood","amount":10} 或 {"type":"mood","all":true,"delta":5} 或 {"type":"hp","delta":-10} 或 {"type":"recruit"} 或 {"type":"log","text":"..."}]}',
  `效果要克制：resource 每项 ±${TUNING.event.llmResourceBound} 内；mood/hp 每项 ±${TUNING.event.llmMoodBound} 内；可组合最多 2 个效果。事件要符合世界现状，不要凭空大规模改变。`,
].join('\n');

export function makeLlmProvider(cfg: LlmConfig, worldSummary: () => SimContext | null): { provider: EventProvider; status(): string } {
  const timeoutMs = cfg.timeoutMs ?? 15000;
  const backoffMs = cfg.backoffMs ?? 30000;
  const maxQueue = cfg.maxQueue ?? 3;
  let queue: ScriptedEvent[] = [];
  let busy = false;
  let seq = 0;
  let lastStatus = 'idle';
  let failCount = 0;
  let lastFailAt = 0;

  async function pull(): Promise<void> {
    if (busy || queue.length >= maxQueue) return;
    if (failCount > 0 && Date.now() - lastFailAt < backoffMs) return;
    busy = true;
    try {
      const ev = await requestEvent(cfg, worldSummary(), timeoutMs, ++seq);
      if (ev) {
        queue.push(ev);
        failCount = 0;
        lastStatus = 'ok';
      }
    } catch (e) {
      failCount++;
      lastFailAt = Date.now();
      lastStatus = `fail x${failCount} (${(e as Error).message.slice(0, 60)})`;
    } finally {
      busy = false;
    }
  }

  const provider: EventProvider = () => {
    if (queue.length === 0) void pull();
    const ev = queue.shift();
    // 消费后立即补拉（保持恒温预取）
    if (queue.length < maxQueue) void pull();
    return ev ?? null;
  };

  void pull(); // 预热

  return {
    provider,
    status: () => lastStatus + (queue.length > 0 ? ` · 队列 ${queue.length}` : ''),
  };
}

async function requestEvent(cfg: LlmConfig, ctx: SimContext | null, timeoutMs: number, seq: number): Promise<ScriptedEvent | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 1.1,
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: ctx ? buildWorldPrompt(ctx) : '世界刚开始：请生成一个开局事件。' },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`llm http ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? '';
  const json = parseLlmJson(content);
  if (!json) throw new Error('llm json 解析失败');
  return toScriptedEvent(json, seq);
}

// 容错解析：剥 ```json fences / 截取首个 {...}
export function parseLlmJson(content: string): LlmEventJson | null {
  let t = content.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    if (typeof obj?.name !== 'string' || !Array.isArray(obj.effects)) return null;
    return { name: obj.name, text: typeof obj.text === 'string' ? obj.text : undefined, effects: obj.effects };
  } catch { return null; }
}

// 白名单执行器：LLM 效果 → sim 世界操作
export function runLlmEffects(ctx: SimContext, effects: LlmEffect[]): void {
  for (const e of effects) {
    if (e.type === 'resource') {
      const cur = ctx.stockpile[e.item] ?? 0;
      ctx.stockpile[e.item] = Math.max(0, Math.min(ctx.tuning.event.eventCap, cur + e.amount));
      if (e.amount > 0) ctx.logEvent(`🎁 获得 ${e.item} ${e.amount}`);
    } else if (e.type === 'mood') {
      const targets = e.all ? ctx.pawnList : pickOne(ctx);
      if (targets) for (const eid of targets) ctx.adjustMood(eid, e.delta);
    } else if (e.type === 'hp') {
      const targets = e.all ? ctx.pawnList : pickOne(ctx);
      if (!targets) continue;
      for (const eid of targets) {
        const hk = ctx.readHealth(eid);
        if (!hk) continue;
        hk.hp = Math.max(1, Math.min(hk.maxHp, hk.hp + e.delta));
        ctx.setHealth(eid, hk);
      }
    } else if (e.type === 'recruit') {
      recruitPawn(ctx);
    }
  }
}

function pickOne(ctx: SimContext): number[] | null {
  if (ctx.pawnList.length === 0) return null;
  return [ctx.pawnList[ctx.rng.int(0, ctx.pawnList.length - 1)]];
}

function recruitPawn(ctx: SimContext): void {
  const cx = Math.floor(ctx.world.width / 2);
  const cy = Math.floor(ctx.world.height / 2);
  const t = ctx.tuning.event;
  for (let r = t.wandererRingMin; r <= t.wandererRingMax; r++) {
    const x = cx + ctx.rng.int(-r, r);
    const y = cy + ctx.rng.int(-r, r);
    if (ctx.world.inBounds(x, y) && ctx.world.isPassable(x, y)) {
      const eid = ctx.spawnPawn(x, y);
      if (eid !== -1) {
        ctx.logEvent('🚶 一名流浪者加入营地');
        ctx.adjustMood(eid, t.wandererMood);
        ctx.bus.emit({ type: 'pawn_recruited', eid });
      }
      return;
    }
  }
}

function toScriptedEvent(json: LlmEventJson, seq: number): ScriptedEvent {
  return {
    id: `llm_${seq}`,
    name: json.name,
    weight: 1,
    run(ctx) {
      runLlmEffects(ctx, json.effects);
      if (json.text) ctx.logEvent(`✨ ${json.name}：${json.text}`);
    },
  };
}
