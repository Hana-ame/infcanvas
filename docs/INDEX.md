# infcanvas 文档索引

> 本文档是仓库所有文档的导航/索引。
> 作用：快速找到“我想了解什么应该读哪篇”，以及“我改了代码应该同步哪篇”。

## 1. 入口文档

| 文档 | 定位 |
| --- | --- |
| `README.md` | 项目总入口：是什么、怎么跑、当前能力 |
| `docs/INDEX.md` | 本文档：全部文档导航 |

## 2. 文档清单

### 核心设计 / 架构

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| `docs/DESIGN.md` | 北极星、神谕模型、卡池决策、世界模型、server authoritative、插件/mod、网络协议、分阶段落地 | 理解游戏灵魂和整体架构时必读 |
| `docs/DATA_DRIVEN.md` | 数据驱动架构：Tile/Building/Recipe/Tuning、ModRegistry、玩法包、契约表、执行序、数值表 | 改数值、加数据表、加玩法包/系统时必读 |
| `docs/REIMPLEMENT_PROMPT.md` | 从零实现规格书：给 LLM 的最小完整 prompt，原则优先于功能 | 想验证/复刻/重新实现整个项目时读 |

### 玩法 / 玩家

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| `docs/PLAYING.md` | 当前版本玩法说明、操作方式、已实现功能清单 | 玩家上手、验收功能时读 |
| `docs/REPLAYS.md` | 神谕、征召、拓荒的趣味回放与设计验证 | 想看实际涌现戏剧性时读 |

### 设计讨论 / 研究

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| `docs/COLAB.md` | 与用户的设计问答、实现报告、方向决策 | 追溯“为什么这么设计”时读 |
| `docs/RESEARCH.md` | 竞品玩法研究报告（DF/RimWorld/LLM 游戏等） | 理解灵感来源和差异化时读 |
| `docs/DLC_REFERENCE.md` | DLC 种子库：大航海/一战/二战/2077/帝国等 | 做 DLC/新玩法包时读 |

### 计划 / 进度 / 实施

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| `docs/PROGRESS.md` | 实现进度表、已完成项、待办/差距、技术栈 | 当前做到哪、下一步做什么时读 |
| `docs/RW_SPRINT.md` | RW-1 第一批实施：工作优先级 + 征召战斗 | 了解 RW-1 M1/M2 落地细节时读 |
| `docs/RW_SPRINT2.md` | RW-1 修订：神谕卡式工作引导 | 了解 RW-1 后续修订时读 |

### 运维 / 部署

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| `docs/DEPLOY.md` | GitHub + Cloudflare Pages 部署配置、注意事项、发布流程 | 部署/推送/排查线上问题时读 |

## 3. 推荐阅读顺序

### 快速了解项目

```text
README.md
→ docs/DESIGN.md（0-3 节）
→ docs/PLAYING.md
→ docs/DATA_DRIVEN.md（前 3 节）
```

### 想修改/新增玩法

```text
docs/DATA_DRIVEN.md
→ docs/AGENTS.md（仓库约定）
→ docs/DESIGN.md（相关系统章节）
→ docs/PROGRESS.md（当前进度）
```

### 想部署/发版

```text
docs/DEPLOY.md
→ README.md（运行方式）
```

### 想从零复刻

```text
docs/REIMPLEMENT_PROMPT.md
→ docs/DATA_DRIVEN.md
→ docs/DESIGN.md
```

### 想做 DLC

```text
docs/DLC_REFERENCE.md
→ docs/DATA_DRIVEN.md（玩法包格式）
→ docs/REIMPLEMENT_PROMPT.md（原则）
```

## 4. 文档维护约定

仓库已有硬性约定（见 `AGENTS.md`）：

- `docs/` 是设计蓝本，**只能追加，不能删改历史行**。
- 改代码必须同步文档：
  - 新功能/修复 → `docs/PROGRESS.md`
  - 玩家可见变化 → `docs/PLAYING.md`
  - 架构/数据模型变化 → `docs/DESIGN.md` / `docs/DATA_DRIVEN.md`
- 部署相关变更 → `docs/DEPLOY.md`
- 新增文档后，记得更新 `docs/INDEX.md`。
