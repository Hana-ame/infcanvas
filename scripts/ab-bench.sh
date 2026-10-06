#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ab-bench.sh —— 配对 A/B 性能对拍（性能线 2026-10-06 追加）
#
# 为什么需要它（这是本文件存在的全部理由）：
#   托管 runner 是共享虚拟机，同机邻居/CPU 频率/steal time 不可控。实测同一份
#   代码、同一个 seed，在两次不同 CI 运行里跑出 68.776ms 与 101.882ms —— **差 48%**。
#   也就是说：拿两次不同运行的读数相减，得到的数字里混着未量化的噪声，
#   **不构成"优化有效"的证据**。
#
#   正确做法（也正是旧项目缺的那一步）：把「优化前」与「优化后」两棵代码树
#   放到**同一台机器、同一个 job 里背靠背交替**地跑。共享 runner 的漂移是
#   随时间缓慢变化的，交替采样能让两条臂吃到几乎相同的漂移，
#   相减之后剩下的就是代码差异。
#
# 为什么不靠运行时开关（A/B flag）实现：
#   在内核里塞 `if (AB_TEST) { 旧路径 } else { 新路径 }` 会让 V8 同时编译两条
#   路径、也可能让两条路径的 JIT 成熟度不同，测出来的差值里混着测量本身的偏差；
#   更糟的是**分支预测器会记住上一轮走哪边**，交替采样时反而引入新的偏差。
#   用两棵真实的代码树没有这个问题：每条臂都是纯粹的单一实现。
#
# 用法：
#   scripts/ab-bench.sh <base-ref> [重复次数] [tick 数]
# 例：
#   scripts/ab-bench.sh origin/main 5 900
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_REF="${1:-origin/main}"
REPEAT="${2:-5}"
TICKS="${3:-900}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKTREE="$(mktemp -d)/base"
echo "▸ 基线 ref: $BASE_REF"
git worktree add --detach "$WORKTREE" "$BASE_REF" >/dev/null
cleanup() {
  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$(dirname "$WORKTREE")" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 基准脚本要能跑在**基线树**上：它只依赖 Sim/ModRegistry/overrideTuning 等
# 优化前就存在的 API（已逐个核对），不含任何本轮新增的接口。
# 反过来，如果哪天基准脚本开始依赖新 API，这个复制会立刻报错——
# 那正是我们想要的：基准与被测代码解耦，基准变了要人确认，而不是悄悄换语义。
cp scripts/bench.ts "$WORKTREE/scripts/bench.ts"
ln -sfn "$REPO_ROOT/node_modules" "$WORKTREE/node_modules"

run_arm() {
  # $1 = 树路径  $2 = 标签
  local tree="$1" tag="$2"
  for seed in 42 7 2026; do
    ( cd "$tree" && npx tsx scripts/bench.ts "$TICKS" "$seed" --pawns=24 ) \
      | grep -o 'BENCH_JSON {.*}' | sed "s/^/AB_JSON ${tag} ${seed} /"
  done
}

# ---- 交替采样：A B A B A B …  两条臂吃同一段时间窗里的 runner 漂移 ----
: > /tmp/ab-results.txt
for i in $(seq 1 "$REPEAT"); do
  echo "▸ 第 $i/$REPEAT 轮交替采样…"
  run_arm "$WORKTREE" base >> /tmp/ab-results.txt
  run_arm "$REPO_ROOT"  opt  >> /tmp/ab-results.txt
done

python3 - "$REPEAT" <<'PY'
import json, sys, statistics, collections

rows = collections.defaultdict(list)
fingerprint = {}
for line in open('/tmp/ab-results.txt', encoding='utf-8'):
    parts = line.split(' ', 3)
    if len(parts) < 4 or parts[0] != 'AB_JSON':
        continue
    _, tag, seed, js = parts
    d = json.loads(js[10:])
    rows[(seed, tag)].append(d)
    # 玩法指纹：两条臂 + 所有轮次必须逐值相同
    fp = (d['alivePawns'], d['hostiles'], d['buildings'], d['events'],
          d['usesTotal'], d['stockFood'], d['stockWood'], d['techsUnlocked'])
    fingerprint.setdefault((seed, 'fp'), set()).add(fp)

print()
print('=' * 96)
print('配对 A/B 性能对拍（同一台 runner，交替采样 %s 轮，取中位数）' % sys.argv[1])
print('=' * 96)

# ---- 先判红线：玩法指纹 ----
bad = False
for seed in ('42', '7', '2026'):
    fps = fingerprint.get((seed, 'fp'), set())
    if len(fps) > 1:
        bad = True
        print('❌ seed=%s 玩法指纹在两臂/多轮之间不一致：' % seed)
        for f in fps:
            print('     ', f)
if bad:
    print('\n结论：指纹不一致 = 「优化改成了算出什么变了」= 回归，不是优化。先修这个。')
    raise SystemExit(1)
print('✅ 玩法指纹两臂 + 全部轮次逐值相同（回归护栏通过）\n')

hdr = f'{"seed":>5} {"臂":>5} {"中位 totalMs":>13} {"最小":>9} {"最大":>9} {"离散度":>9} {"behavior":>10} {"Δ total":>9}'
print(hdr)
print('-' * len(hdr))

for seed in ('42', '7', '2026'):
    med = {}
    for tag in ('base', 'opt'):
        ds = rows.get((seed, tag))
        if not ds:
            continue
        totals = sorted(d['totalMs'] for d in ds)
        m = statistics.median(totals)
        beh = statistics.median(d['sysMs'].get('behavior', 0) for d in ds)
        lo, hi = totals[0], totals[-1]
        spread = (hi - lo) / lo * 100 if lo else 0
        med[tag] = m
        label = '优化前' if tag == 'base' else '优化后'
        print(f'{seed:>5} {label:>5} {m:>13.3f} {lo:>9.3f} {hi:>9.3f} {spread:>8.1f}% {beh:>10.3f} '
              f'{("" if tag == "base" else f"{(m-med["base"])/med["base"]*100:+.1f}%"):>9}')
    if 'base' in med and 'opt' in med:
        delta = (med['opt'] - med['base']) / med['base'] * 100
        # 噪声地板：两臂各自的离散度。差值必须显著大于它才算信号。
        noise = max(
            max(d['totalMs'] for d in rows[(seed, 'base')]) - min(d['totalMs'] for d in rows[(seed, 'base')]),
            max(d['totalMs'] for d in rows[(seed, 'opt')]) - min(d['totalMs'] for d in rows[(seed, 'opt')]),
        ) / max(med['base'], 1e-9) * 100
        verdict = '信号可信' if abs(delta) > noise else '⚠ 不显著：差值落在噪声内，本配置**测不出**收益'
        delta_s = '{:+.1f}%'.format(delta)
        noise_s = '{:.1f}%'.format(noise)
        print(f'{seed:>5} → Δ {delta_s}（噪声地板 ±{noise_s}）{verdict}')
    print()
PY
