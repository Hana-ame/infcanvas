// 纯逻辑命令行玩法（无前端渲染）：npx tsx scripts/play.ts
// 交互式：输入命令控制游戏（或直接回车 = 走 1 秒）
// 常用命令：
//   s / <空格>    走 1 秒
//   f             连续跑（Ctrl+C 停止）
//   state         全局状态（库存/人口/派系/科技/队列）
//   pawns         小人列表
//   sel <id>      选中小人
//   move <x> <y>  选中小人移动
//   build <id> <x> <y>  建造
//   job <job>     选中小人指派职业（lumberjack/miner/farmer/crafter/fisher/自由=空）
//   oracle        神谕祝福（教堂）/ 印策略卡
//   speed <n>     连续跑速度（秒/帧）
//   techs         已解锁科技
//   help          帮助
import { Sim } from '../src/sim/sim';
import { makeDummyCardPlanner } from '../src/server/dummyLlm';
import { TECHS } from '../src/sim/defs/techs';
import { JOBS, jobLabelOf } from '../src/sim/defs/jobs';
import { createInterface } from 'readline';

const sim = new Sim({ seed: 20260803, pawnCount: 4 });
let selected: number | null = null;
let running = false;
let speed = 1; // 连续跑时每帧走几秒

const planner = makeDummyCardPlanner(sim as never, {
  mode: 'feedback', interval: 90, techInterval: 120,
  onPrint: (def) => { sim.logEvent(`🃏 神谕降旨：${def.label}${def.reason ? `（${def.reason}）` : ''}`); },
});

const fmt = (v: number | undefined): string => (v === undefined ? '-' : Math.round(v).toString());
const weather = (): string => sim.env.raining ? '🌧 雨' : (sim.isNight() ? '🌙 夜' : '☀ 昼');

function statusLine(): string {
  const s = sim.stockpile;
  return [
    `${fmt(sim.time / 60)}分 ${weather()} ${sim.paused ? '⏸' : `${sim.speed}x`}`,
    `🌲${fmt(s.wood)} 🪨${fmt(s.ore)} 🍖${fmt(s.food)} 🛠️${fmt(s.tools)} 👥${sim.pawns.length}`,
    `科技:${[...sim.techs].map((t) => TECHS[t]?.name ?? t).join('/') || '无'} 队列:${sim.buildQueue.length}`,
  ].join('  ');
}

function showState(): void {
  const s = sim.stockpile;
  console.log(`\n=== 状态 ${statusLine()} ===`);
  console.log(`篝火聚居 ${sim.factionsView().length} 处：`);
  for (const f of sim.factionsView()) {
    console.log(`  🔥 营地@(${f.key % sim.world.width},${Math.floor(f.key / sim.world.width)}) 成员${f.members.length}：${f.members.map((e) => `#${e}`).join('、') || '暂无'}`);
  }
  console.log(`建筑 ${sim.world.buildings.size} 座：`);
  for (const [k, b] of sim.world.buildings) {
    console.log(`  ${b.def.name}@(${k % sim.world.width},${Math.floor(k / sim.world.width)}) ${b.faction} hp${fmt(b.hp)}`);
  }
  if (sim.buildQueue.length > 0) {
    console.log(`建造队列：`);
    for (const b of sim.buildQueue) console.log(`  ${b.defId}@(${b.x},${b.y}) ${fmt(b.progress)}/${b.defId === 'wall' ? 3 : 2}s`);
  }
  console.log(`最近事件：${sim.events.slice(-3).map((e) => `[${Math.floor(e.time)}s]${e.text}`).join(' | ')}`);
}

function showPawns(): void {
  console.log(`\n小人 ${sim.pawns.length} 个：`);
  for (const eid of sim.pawns) {
    const p = sim.pawnProfile(eid);
    if (!p) continue;
    const mark = eid === selected ? '▸' : ' ';
    console.log(`  ${mark}#${eid} ${p.job || '闲逛'}${p.assignedJob ? `(指派${jobLabelOf(p.assignedJob)})` : ''} @(${Math.round(p.pos.x)},${Math.round(p.pos.y)}) 饥${fmt(p.needs?.food)} 疲${fmt(p.needs?.rest)} 心${fmt(p.needs?.mood)} 卡${p.slots.filter((c) => c).length}张`);
  }
}

// ASCII 地形图（无前端渲染时"看"世界）：字符 + ANSI 色
const TILE_CHAR: Record<string, [string, string]> = {
  grass: ['.', '\x1b[32m'], tree: ['T', '\x1b[38;5;28m'], water: ['~', '\x1b[34m'],
  sand: ['·', '\x1b[33m'], desert: ['"', '\x1b[38;5;179m'], stone: ['#', '\x1b[37m'],
  mountain: ['^', '\x1b[38;5;240m'], bridge: ['=』', '\x1b[38;5;130m'],
};
function showMap(cx: number, cy: number, w = 36, h = 20): void {
  const chars = new Map<number, string>();
  for (const [k, b] of sim.world.buildings) {
    const sym = b.def.id === 'campfire' ? '🔥' : b.def.id === 'church' ? '⛪' : b.def.emoji ?? '□';
    chars.set(k, `${b.faction === 'auto' ? '' : ''}${sym}`);
  }
  // 出生中心 = 世界中心
  const wx = cx === -1 ? Math.floor(sim.world.width / 2) : cx;
  const wy = cy === -1 ? Math.floor(sim.world.height / 2) : cy;
  const x0 = Math.max(0, Math.min(sim.world.width - w, wx - Math.floor(w / 2)));
  const y0 = Math.max(0, Math.min(sim.world.height - h, wy - Math.floor(h / 2)));
  let out = `\x1b[2J\x1b[H 地图 ${x0},${y0} ~ ${x0 + w},${y0 + h}（size ${sim.world.width}x${sim.world.height}）\n`;
  for (let y = y0; y < y0 + h; y++) {
    let row = '  ';
    for (let x = x0; x < x0 + w; x++) {
      const k = x + y * sim.world.width;
      const pawn = sim.pawns.find((eid) => {
        const p = sim.pawnPositions.get(eid);
        return p && Math.floor(p.x) === x && Math.floor(p.y) === y;
      });
      const b = chars.get(k);
      if (pawn !== undefined) row += '\x1b[36m█\x1b[0m';
      else if (b) row += b;
      else {
        const t = sim.world.getTile(x, y);
        const [ch, color] = TILE_CHAR[t] ?? ['?', '\x1b[0m'];
        row += `${color}${ch}\x1b[0m`;
      }
    }
    out += row + '\n';
  }
  console.log(out + '\x1b[0m');
}

function showHelp(): void {
  console.log(`
命令（回车 = 走 1 秒）：
  state            全局状态
  pawns            小人列表
  sel <id>         选中小人
  move <x> <y>     选中小人移动
  build <id> <x> <y> 建造（篝火/墙/农田/竹筏/桥…；科技锁自动拒绝）
  job [job]        指派职业（lumberjack/miner/farmer/crafter/fisher，空=自由）
  oracle           选教堂发布神谕（祝福）/ 印策略卡
  f                连续跑（Ctrl+C 停）
  speed <n>        连续跑速度（秒/帧）
  techs            已解锁科技
  map [x y]        看地图（默认出生点窗口；x y 选中心）
  pause            暂停/继续
  quit             退出`);
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`infcanvas 纯逻辑玩法（seed 20260803，4 小人）`);
  console.log(`输入 help 查看命令。直接回车 = 走 1 秒。`);
  sim.logEvent('🏕 新世界诞生，神谕俯瞰众生');

  const ask = (): void => {
    if (running) return;
    rl.question(`[${fmt(sim.time)}s] ${selected !== null ? `#${selected} ` : ''}> `, (line) => {
      handle(line.trim());
      ask();
    });
  };

  const handle = (line: string): void => {
    if (!line) { stepOnce(1); return; }
    const [cmd, ...args] = line.split(/\s+/);
    switch (cmd) {
      case 'state': showState(); break;
      case 'pawns': case 'p': showPawns(); break;
      case 'sel': {
        const id = Number(args[0]);
        if (sim.pawns.includes(id)) { selected = id; console.log(`选中 #${id}`); }
        else console.log(`小人 #${id} 不存在`);
        break;
      }
      case 'move': {
        if (selected === null) { console.log('先 sel <id> 选中小人'); break; }
        sim.issueCommand({ type: 'move', x: Number(args[0]), y: Number(args[1]), pawnId: selected });
        console.log(`#${selected} 前往 (${args[0]},${args[1]})`);
        break;
      }
      case 'build': {
        const [id, x, y] = args;
        sim.issueCommand({ type: 'build', x: Number(x), y: Number(y), buildingId: id });
        const queued = sim.buildQueue.some((b) => b.defId === id && b.x === Number(x) && b.y === Number(y));
        console.log(queued ? `🏗 ${id} 蓝图入队 @(${x},${y})` : `❌ ${id} 未能入队（资源不足/科技锁/落点非法）`);
        break;
      }
      case 'job': {
        if (selected === null) { console.log('先 sel <id> 选中小人'); break; }
        const job = args[0] ?? '';
        sim.issueCommand({ type: 'assign', x: 0, y: 0, job, pawnId: selected });
        console.log(`#${selected} ${job ? `指派为 ${jobLabelOf(job)}` : '恢复自由'}`);
        break;
      }
      case 'oracle': {
        // 找教堂发布神谕；无教堂则印一张策略卡（神谕随性）
        const church = [...sim.world.buildings.entries()].find(([, b]) => b.def.capabilities?.includes('oracle'));
        if (church) {
          sim.issueCommand({ type: 'oracle', x: church[0] % sim.world.width, y: Math.floor(church[0] / sim.world.width) });
          console.log('✨ 神谕降下，祝福信众');
        } else {
          planner.tick(99999); // 触发一次印卡（行为+科技）
          console.log('✨ 神谕低语（无教堂 → 直接印策略卡）');
        }
        break;
      }
      case 'f': {
        running = true;
        const timer = setInterval(() => {
          if (!running) { clearInterval(timer); ask(); return; }
          stepOnce(speed);
        }, 200);
        console.log(`连续跑（每 0.2s 走 ${speed}s），任意键暂停…`);
        rl.once('line', () => { running = false; });
        break;
      }
      case 'speed': speed = Number(args[0]) || 1; console.log(`速度 ${speed}s/帧`); break;
      case 'techs': console.log(`已解锁：${[...sim.techs].map((t) => `${TECHS[t]?.name ?? t}${TECHS[t] ? `（${TECHS[t].desc}）` : ''}`).join('\n  ') || '无'}`); break;
      case 'map': showMap(Number(args[0] ?? -1), Number(args[1] ?? -1)); break;
      case 'pause': sim.paused = !sim.paused; console.log(sim.paused ? '⏸ 暂停' : '▶ 继续'); break;
      case 'help': case 'h': showHelp(); break;
      case 'quit': case 'exit': console.log('👋'); process.exit(0); break;
      default: console.log(`未知命令 ${cmd}（help 查看）`);
    }
  };

  // 20Hz 模拟步进（与 server TICK_HZ=20 同频）：secs 秒折合步数，至少走 1 步
  const stepOnce = (secs: number): void => {
    for (let i = 0; i < Math.max(1, Math.round(secs * 20)); i++) {
      sim.step(1 / 20);
      planner.tick(1 / 20);
    }
    console.log(statusLine());
  };

  ask();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
