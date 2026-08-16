// test/browser.js
// 给 /test/ 提供无需构建、纯静态可玩的网页版最小核心。
// 逻辑是 minimal-core.ts 的浏览器可直接运行版本（省略 TypeScript 类型）。
// 用于验证 prompt 的“一切皆抽卡 + 自主生存”，不依赖主仓库构建。

const CARD_IDS = ['idle', 'gatherFood', 'eat', 'gatherWood', 'buildCampfire', 'rest', 'socialize'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function nearest(items, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.hypot(it.x - x, it.y - y);
    if (d < bestD) {
      best = it;
      bestD = d;
    }
  }
  return best;
}

function makeWorld(w, h, rng) {
  const berries = [];
  const trees = [];
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  for (let i = 0; i < 6; i++) {
    berries.push({
      x: clamp(cx + Math.floor(rng() * 12 - 6), 1, w - 2),
      y: clamp(cy + Math.floor(rng() * 12 - 6), 1, h - 2),
      amount: 3 + Math.floor(rng() * 4),
    });
  }
  for (let i = 0; i < 8; i++) {
    trees.push({
      x: clamp(cx + Math.floor(rng() * 14 - 7), 1, w - 2),
      y: clamp(cy + Math.floor(rng() * 14 - 7), 1, h - 2),
      hp: 1,
    });
  }
  return { w, h, berries, trees, campfires: [] };
}

function needModifier(pawn, id) {
  switch (id) {
    case 'gatherFood':
    case 'eat':
      return pawn.food < 30 ? 4 : pawn.food < 55 ? 2 : 1;
    case 'rest':
      return pawn.rest < 25 ? 5 : pawn.rest < 55 ? 2 : 1;
    case 'socialize':
      return pawn.mood < 40 ? 2.5 : 1;
    case 'idle':
      return pawn.mood > 85 ? 1.5 : 1;
    default:
      return 1;
  }
}

function decayNeeds(pawn) {
  pawn.food = Math.max(0, pawn.food - 0.18);
  pawn.rest = Math.max(0, pawn.rest - 0.14);
  pawn.mood = Math.max(0, pawn.mood - 0.05);
  pawn.san = Math.max(0, pawn.san - 0.02);
}

function makeCards() {
  return [
    {
      id: 'gatherFood', label: '采集野果', baseWeight: 10, condition: () => true,
      effect(pawn, sim) {
        const b = sim.nearestBerry(pawn);
        if (!b) return;
        if (Math.hypot(b.x - pawn.x, b.y - pawn.y) <= 1.5) {
          const take = Math.min(b.amount, 2);
          b.amount -= take;
          sim.stockpile.food += take;
          if (b.amount <= 0) sim.world.berries.splice(sim.world.berries.indexOf(b), 1);
        } else {
          sim.moveToward(pawn, b.x, b.y);
        }
      },
    },
    {
      id: 'eat', label: '吃东西', baseWeight: 8,
      condition: (pawn, sim) => sim.stockpile.food > 0 && pawn.food < 70,
      effect(pawn, sim) {
        sim.stockpile.food -= 1;
        pawn.food = Math.min(100, pawn.food + 35);
        pawn.mood = Math.min(100, pawn.mood + 2);
      },
    },
    {
      id: 'gatherWood', label: '砍柴', baseWeight: 7, condition: () => true,
      effect(pawn, sim) {
        const t = sim.nearestTree(pawn);
        if (!t) return;
        if (Math.hypot(t.x - pawn.x, t.y - pawn.y) <= 1.5) {
          t.hp -= 1;
          if (t.hp <= 0) {
            sim.world.trees.splice(sim.world.trees.indexOf(t), 1);
            sim.stockpile.wood += 1;
          }
        } else {
          sim.moveToward(pawn, t.x, t.y);
        }
      },
    },
    {
      id: 'buildCampfire', label: '建造篝火', baseWeight: 4,
      condition: (pawn, sim) => sim.stockpile.wood >= 3 && sim.world.campfires.length < 2,
      effect(pawn, sim) {
        sim.stockpile.wood -= 3;
        sim.world.campfires.push({ x: pawn.x, y: pawn.y });
        sim.pushLog('🔥 篝火建成！');
      },
    },
    {
      id: 'rest', label: '睡觉休息', baseWeight: 6, condition: (pawn) => pawn.rest < 60,
      effect(pawn, sim) {
        pawn.rest = Math.min(100, pawn.rest + 30);
        if (sim.nearCampfire(pawn)) pawn.san = Math.min(100, pawn.san + 5);
      },
    },
    {
      id: 'socialize', label: '社交闲聊', baseWeight: 5,
      condition: (pawn, sim) => sim.nearbyPawn(pawn) !== null,
      effect(pawn, sim) {
        const other = sim.nearbyPawn(pawn);
        pawn.mood = Math.min(100, pawn.mood + 8);
        if (other) other.mood = Math.min(100, other.mood + 4);
      },
    },
    {
      id: 'idle', label: '发呆', baseWeight: 3, condition: () => true,
      effect(pawn) {
        pawn.mood = Math.min(100, pawn.mood + 1);
      },
    },
  ];
}

class TinySim {
  constructor(options = {}) {
    const seed = options.seed ?? 20260816;
    this.rng = mulberry32(seed);
    this.oracleGoal = options.oracleGoal ?? {};
    this.logEnabled = options.log ?? true;
    this.world = makeWorld(options.mapW ?? 24, options.mapH ?? 24, this.rng);
    this.cards = makeCards();
    this.stockpile = { food: 0, wood: 0 };
    this.pawns = [];
    this.events = [];
    this.tick = 0;

    const count = options.pawnCount ?? 4;
    const cx = Math.floor(this.world.w / 2);
    const cy = Math.floor(this.world.h / 2);
    for (let i = 0; i < count; i++) {
      const x = clamp(cx + (i % 2 === 0 ? -1 : 1) + Math.floor(this.rng() * 3 - 1), 1, this.world.w - 2);
      const y = clamp(cy + (i < 2 ? -1 : 1) + Math.floor(this.rng() * 3 - 1), 1, this.world.h - 2);
      this.pawns.push({
        id: i + 1,
        name: `鼠${i + 1}`,
        x,
        y,
        hp: 100,
        food: 80 + Math.floor(this.rng() * 20),
        rest: 80 + Math.floor(this.rng() * 20),
        mood: 80 + Math.floor(this.rng() * 20),
        san: 100,
        mastery: {},
        uses: {},
        currentCard: null,
      });
    }
    this.pushLog('🏕 4 只鼠鼠出生，试验“一切皆抽卡”最小核心');
  }

  pushLog(msg) {
    if (this.logEnabled) this.events.push(`[${this.tick}s] ${msg}`);
  }

  nearCampfire(pawn) {
    return this.world.campfires.some((c) => Math.hypot(c.x - pawn.x, c.y - pawn.y) <= 2);
  }

  nearbyPawn(pawn, radius = 2) {
    let best = null;
    let bestD = radius;
    for (const other of this.pawns) {
      if (other.id === pawn.id) continue;
      const d = Math.hypot(other.x - pawn.x, other.y - pawn.y);
      if (d <= bestD) {
        best = other;
        bestD = d;
      }
    }
    return best;
  }

  nearestBerry(pawn) {
    return nearest(this.world.berries, pawn.x, pawn.y);
  }

  nearestTree(pawn) {
    return nearest(this.world.trees, pawn.x, pawn.y);
  }

  moveToward(pawn, tx, ty) {
    const dx = Math.sign(tx - pawn.x);
    const dy = Math.sign(ty - pawn.y);
    if (dx !== 0) pawn.x += dx;
    else if (dy !== 0) pawn.y += dy;
    pawn.x = clamp(pawn.x, 0, this.world.w - 1);
    pawn.y = clamp(pawn.y, 0, this.world.h - 1);
  }

  cardWeight(pawn, card) {
    const base = card.baseWeight;
    const need = needModifier(pawn, card.id);
    const mastery = pawn.mastery[card.id] ?? 0;
    const habit = 0.5 + mastery / 100;
    const oracle = this.oracleGoal[card.id] ?? 1;
    return Math.max(0, base * need * habit * oracle);
  }

  drawCard(pawn) {
    const candidates = this.cards.filter((c) => c.condition(pawn, this));
    const weights = candidates.map((c) => this.cardWeight(pawn, c));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return this.cards.find((c) => c.id === 'idle');
    let r = this.rng() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  step() {
    this.tick += 1;
    for (const pawn of this.pawns) {
      decayNeeds(pawn);
      const card = this.drawCard(pawn);
      pawn.currentCard = card.id;
      this.pushLog(`${pawn.name} 抽到「${card.label}」(${Math.round(pawn.food)}/${Math.round(pawn.rest)}/${Math.round(pawn.mood)})`);
      card.effect(pawn, this);
      pawn.uses[card.id] = (pawn.uses[card.id] ?? 0) + 1;
      pawn.mastery[card.id] = Math.min(100, (pawn.mastery[card.id] ?? 0) + 2);
      for (const id of CARD_IDS) {
        if (id !== card.id && (pawn.mastery[id] ?? 0) > 0) {
          pawn.mastery[id] = Math.max(0, pawn.mastery[id] - 0.02);
        }
      }
      pawn.san = Math.max(0, Math.min(100, pawn.san));
      pawn.mood = Math.max(0, Math.min(100, pawn.mood));
    }
    this.pushLog(`库存: 🍎${this.stockpile.food} 🪵${this.stockpile.wood} 🔥${this.world.campfires.length}`);
  }
}

// ---- 页面控制 ----
const $ = (id) => document.getElementById(id);

let sim = new TinySim({ seed: 20260816, log: true });
let timer = null;

function render() {
  $('tick').textContent = String(sim.tick);
  $('pawns').textContent = String(sim.pawns.length);
  $('food').textContent = String(sim.stockpile.food);
  $('wood').textContent = String(sim.stockpile.wood);
  $('campfires').textContent = String(sim.world.campfires.length);
  $('oracle').textContent = sim.oracleGoal.gatherFood ? `是 x${sim.oracleGoal.gatherFood}` : '否';

  const rows = CARD_IDS.map((id) => {
    const total = sim.pawns.reduce((s, p) => s + (p.uses[id] ?? 0), 0);
    const avg = sim.pawns.reduce((s, p) => s + (p.mastery[id] ?? 0), 0) / Math.max(1, sim.pawns.length);
    return `<tr><td>${id}</td><td>${total}</td><td>${Math.round(avg)}</td></tr>`;
  }).join('');
  $('cardRows').innerHTML = rows;

  const logEl = $('log');
  logEl.innerHTML = sim.events.slice(-120).map((e) => `<div>${e}</div>`).join('');
  logEl.scrollTop = logEl.scrollHeight;
}

function reset() {
  stop();
  sim = new TinySim({ seed: 20260816, log: true });
  render();
}

function stepOnce() {
  sim.step();
  render();
}

function toggleRun() {
  if (timer) {
    stop();
    return;
  }
  $('state').textContent = '运行中';
  $('runBtn').textContent = '暂停';
  timer = setInterval(() => {
    for (let i = 0; i < 5; i++) sim.step();
    render();
  }, 50);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  $('state').textContent = '已停止';
  $('runBtn').textContent = '自动跑';
}

$('stepBtn').addEventListener('click', stepOnce);
$('runBtn').addEventListener('click', toggleRun);
$('resetBtn').addEventListener('click', reset);
$('oracleBtn').addEventListener('click', () => {
  sim.oracleGoal = sim.oracleGoal.gatherFood ? {} : { gatherFood: 5 };
  render();
});

reset();
