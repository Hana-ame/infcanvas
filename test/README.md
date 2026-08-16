# test/ 最小核心验证项目

这是一个**独立测试项目**，建立在本仓库 `test/` 目录下，**不修改任何主代码**。

目的：验证 `docs/REIMPLEMENT_PROMPT.md`（提交 `1eb44ea`）里最关键的判断——

> 原则优先于功能；违反原则即为失败，无论功能多全。

这里只实现 prompt 的最小核心：

- **一切皆抽卡**：每个鼠鼠每个 tick 从卡池抽卡，权重 = 基础权重 × 需求调制 × 熟练度 × 神谕目标。
- **自主生存循环**：4 只鼠鼠自动采集野果/砍柴/进食/休息/社交/建造篝火。
- **神谕只引导**：`oracleGoal` 只改变权重，不直接指挥单个小人。

## 运行

```bash
# 跑 60 tick demo，观察抽卡日志与统计
npx tsx test/run.ts 60 20260816

# 跑自检（不依赖 vitest，也不会被根仓库 npm test 收集）
npx tsx test/check.ts
```

## 文件

- `minimal-core.ts` —— 最小核心实现：TinySim + 卡表 + 需求衰减 + 熟练度演化。
- `run.ts` —— CLI demo 入口。
- `check.ts` —— 自检脚本，验证确定性、自主生存、神谕只引导。
- `tsconfig.json` —— 本测试项目的独立 TS 配置（只检查 `test/`，不碰主代码）。

## 隔离说明

- 不在 `test/` 下使用 `*.test.ts` 后缀，避免被主仓库 Vitest 自动收集。
- `tsconfig.json` 独立，`npm run typecheck`（主仓库）仍只检查 `src/`。
- 若想单独类型检查本测试项目：

```bash
npx tsc -p test/tsconfig.json --noEmit
```

也可以用独立 test 包脚本（不会影响根仓库 npm scripts）：

```bash
npm --prefix test run demo
npm --prefix test run check
npm --prefix test run typecheck
```

## 网页版（可选）

如果想在浏览器里“玩”，已经加了纯静态页面：

```bash
npm run dev
# 打开 http://localhost:5173/test/
```

页面在 `test/index.html` + `test/browser.js`，不需要额外构建步骤，也不影响主游戏页面。
如果部署方式是把仓库根目录直接作为静态站点（而不是只部署 `dist/`），push 后 `你的站点/test/` 就可以访问这个演示。
