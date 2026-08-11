# 实现进度（P0 单机 MVP）

> 与 docs/DESIGN.md 对齐的状态记录。每完成一块打勾并注明对应设计章节。

## 北极星
**模拟一个现实的社会**（DESIGN §0）。当前 P0 在验证"小人自主运转"的最小闭环，
神谕/信仰/LLM 属 P1.5+，此处仅保留确定性骨架。

## 已完成（P0）

| 设计项 | 章节 | 状态 | 说明 |
|---|---|---|---|
| 世界生成 | §3 空间模型 | ✅ | Minecraft-like 值噪声（fBm）：海拔+湿度双轴 → 水/沙/草/沙漠/森林/矿/山。出生点 5x5 保证草地 + **近圈资源保证**（饥荒式开局：出生点 3-8 圈确定性撒树/矿/石，开局采矿不落空） |
| 小人自主 AI | §3/§6 | ✅ | 抽 3 选 1 卡系统（种子化不放回）+ 收益择优；基础卡 + DNA 天赋卡（夜猫子/热爱工作/好斗/虔诚/懒惰/强壮/机灵） |
| 意图失真（简化） | §2/§6 | ✅ | 违抗 roll：仅当选中工作卡且有未选本我卡时触发，概率受懒惰/心情/信仰调制，30s 冷却防刷屏 |
| 插槽系统 | §3 插槽/§6 | ✅ | DNA 决定槽位 + 天赋卡占槽；统一卡模型（天赋卡→技能/习惯/神谕策略卡属 P0.5） |
| COC 技能成长 | §3 技能成长 | ✅ | 技能百分制（work/fight/craft/social/faith）；成长=用技能后掷 d100>当前值→+1d10（COC 规则）；技能检定 rollEventSkill（技能越高越稳）；工作→work、战斗→fight；随存档持久化 |
| COC 八属性 | §3 属性卡 | ✅ | **STR/CON/SIZ/DEX/APP/INT/POW/EDU 全八属性**；天赋调制（强壮→STR/SIZ↑、机灵→INT/DEX↑、夜猫子→POW↑）；用途落地：CON+SIZ→HP 上限、POW→SAN 抗压+压制恶意槽、DEX→战斗闪避、STR→采集产出、APP→信仰传播、INT+EDU→技能起点、INT→检定加成；HUD 八属性显示 |
| 七宗罪欲望 | §3 欲望系统 | ✅ | **P0 版**：七宗罪满足度 + 先天罪孽倾向（DNA.sins，天赋调制）；吃→暴食、休息→懒惰、工作→贪婪、祈祷→傲慢；定期检查→欲望驱动卡权重（匮乏的欲望→对应系列卡权重↑）+ 心情影响；恶意槽（长期匮乏→偷窃/砸建筑/暴躁）；HUD 显示、存档持久化。色欲/嫉妒满足途径待 P1 |
| 寻路 | §3 | ✅ | A*（暗黑格 ×3 代价）+ trailCache 缓存 |
| 需求系统 | §3 | ✅ | 饥饿/精力/心情衰减 + 紧急需求（饿→吃、困→睡）+ 饿死 |
| SAN 理智 | §3 SAN | ✅ | 目睹死亡掉理智（距离衰减）；黑夜远离篝火持续流失；篝火旁恢复；<25 狂乱（发呆/乱跑），行为接管 |
| 昼夜 | §3 | ✅ | 120s/天；夜晚精力消耗快 + 屏幕遮罩 + SAN 黑暗恐惧 |
| 环境系统 | §6 环境调制 | ✅ | **天气/气温**（EnvState）：气温随昼夜波动（正午热/深夜凉）+ 天气偏移；确定性雨-晴循环；环境调制卡权重（下雨→户外工作×0.5、娱乐×1.6；酷暑/严寒→户外工作×0.6、生理×1.3）；HUD 显示天气 |
| 马尔可夫偏置 | §6 卡相互作用 | ✅ | **MARKOV_BIAS**：上一轮卡系列→本轮权重偏置（干完活想歇、吃饱想动、闲了想干活…），数据表驱动（mod 可扩展）；lastSeries 决策链记录 |
| 叙事压力 | §6 叙事压力 | ✅ | **和平越久袭击越猛**：和平时长积累 → 战斗压力（1→2×）→ 袭击间隔缩短 + 规模放大（数量、血量）；"和平→压力→冲突"节奏闭环 |
| 生产 | §3 欲望咬合 | ✅ | 伐木/采矿进度+骰子产出、工作台→工具（采集 ×1.3）、农田产粮、矿洞持续产矿（饥荒式矿场，40s 一轮） |
| 篝火光环 | §3/饥荒式 | ✅ | 篝火 = 社会锚点：半径 6 内心情回暖 + 夜晚不易困（SAN 恢复已由 SanSystem 覆盖）；与祈祷/疗伤/SAN 共同构成篝火的多功能定位 |
| 建造 | §3 | ✅ | 篝火/墙/地板/门/农田/工作台/矿洞；蓝图排队 + 幽灵预览 + 建造进度 |
| 战斗/袭击 | §3 | ✅ | 狼群周期性袭击（人数 scaling），攻击小人/建筑，死亡掉落 |
| 伤亡系统 | §3 | ✅ | HP、战斗受伤、饿死、死亡事件（喂给 SAN 与日志） |
| 历史日志 | §3 历史系统 | ✅ | **结构化仿真日志**（HistoryLog）：订阅全部 GameEvent → 条目（时间/天/类型/实体/地点/原因/事实），可查询（type/eid）、可导出（toJSON）、HUD 有 📜 历史面板；事实只来自 sim（LLM 只润色原则就位） |
| 流言/对话 | §6 狗屁倒灶 | ✅ | **微互动层**（确定性模板，零 LLM）：相遇→打招呼/抱怨/表情，心情+好感度双向变化；话题从结构化历史抽取（聊最近的事）→ `social` 事件入历史；HUD feed 显示 💬 闲聊。**传教对抗**（DESIGN §3 对抗检定）：高信仰者尝试说服→传教者(APP/2+faith/2) vs 目标(POW+信仰抵抗)掷骰比成败→成功升信仰+好感、失败反感。闲聊/深聊 LLM 层待 P1 |
| 修理 | §3 | ✅ | 受损建筑自动修理（RepairSystem） |
| 人口 | §3 | ✅ | 死亡/成长（PopulationSystem） |
| 随机事件 | §6/用户Q5 | ✅ | **预制剧本事件系统**（EventSystem + EventProvider 接口）：流浪者加入/丰收/矿脉/瘟疫/游商/庆典，**状况匹配事件列表**（每个事件带 `condition`——有农田才丰收、有余粮才收留流浪者、人多才有瘟疫…只有符合当前局面的事件进候选池，权重+冷却+minTime 调制）；**provider 可插换 = 预留 LLM 插入能力**（P0 确定性随机，P1 换 LLM provider）；事件入历史 |
| 社会关系 | §3/用户Q8 | ✅ | **好感度驱动行为**：亲密(≥40)相邻→心情加成（协作正向反馈）；敌对(≤-20)相邻→口角、积累冲突→动手（STR 判定、掉血、负好感加深，战争萌芽）；关系由社交微互动/传教积累 |
| 派系优先级 | §3/用户Q8 | ✅ | **AI 按环境下达工作优先指令**（RimWorld 工作优先的确定性版）：每 10s 评估资源短缺/建造队列 → 调制全营地对应工作卡权重（食<60→farm↑、木<40→chop↑、矿<15→mine↑、排队→build↑）；随环境自动转变 |
| 自主扩张 | §3/用户Q1/Q8 | ✅ | **AutonomousBuildSystem**：AI 评估资源与营地状态自动规划扩建（无篝火→起篝火、人多吃紧→加火、缺粮→扩农田、缺工具→工作台、矿少→矿洞、富余→围墙、**信仰高→建教堂**）；20-30s 评估一次注入 buildQueue，小人照常执行；营地自主生长（观察模拟器核心） |
| 教堂 + 神谕 | §3/用户Q2/Q3 | ✅ | **教堂**（2x2，信仰≥35 自动建）+ **神谕影响**：玩家选中教堂→"发布神谕"按钮→祝福附近(半径6)高信仰小人（信任=信仰/100 过滤，低信仰不受影响）：30s 心情 buff + 信仰↑；教堂是神谕唯一物理接口（DESIGN §3）；神谕不直接指挥，只影响目标层 |
| 社会单位/部落记忆 | 用户Q9+即时指令 | ✅ | **有篝火 = 独立派系**。每个篝火 = SocialUnit：部落记忆（成员/事件/看法）、名字、成员归属。**教堂 = 篝火升级**（容量：篝火记 2-3 连接、教堂 5-10）。**篝火间信任机制**：成员协作→看法增；双向友好→贸易（木换食）；双向敌对→派掠夺者攻打对方（战争）→加深仇恨；**派系 = 单位间的看法关系**（友好→贸易/伙伴、敌对→战争，无抽象联盟层）：双向敌对→派掠夺者攻打对方（战争）→加深仇恨。出生点初始篝火=首派系；野生篝火事件刷新新势力 |
| 存档 | §5 | ✅ | **IndexedDB**（异步、大容量），30s 自动存档；旧 localStorage 存档已弃用；含社会单位（派系/记忆/看法/库存/玩家所属）持久化 |
| 渲染 | §1 | ✅ | PixiJS v8；SVG 素材（btoa data-uri → GraphicsContext）；地形/建筑/小人/敌人生成 |
| 视角切换 | §1 渲染 | ✅ | **2D 俯视 ↔ 2.5D 同轴**（右下角按钮）；2.5D 按世界 y 排序实现前后遮挡（树/建筑/小人/敌人统一进 entityLayer，zIndex=y×10+层级） |
| HUD | §1 | ✅ | 资源条、建造菜单、速度控制（⏸/1x/2x/3x）、缩放按钮（+/-）+ PageUp/PageDown、帮助、事件 feed、选中面板（COC 属性/天赋/插槽/需求/HP/信仰/理智/闪念）、建筑面板 |
| 测试 | §6 | ✅ | vitest：RNG 确定性、地形确定性、抽卡、移动/建造/采矿闭环、SAN 目睹死亡/篝火恢复 |
| mod 注册表 | §7 | ✅ | **ModRegistry**（DESIGN §7 扩展性原则）：运行时注册 tile/building/item/**enemy**/card/recipe/event/expansionPlan/intent/work/system/hook + overrideDef/overrideTuning + 冲突检测；`SimOptions.mods` 构造期挂载；详见 docs/DATA_DRIVEN.md（§6 验收 17 项全 ✅，89 测试覆盖） |
| 数据驱动化 | §7 | ✅ | **sim 层 defId 特判清零**：craft 自配方/发光/升级(upgradesTo)/神谕(capabilities)/派系优先级表/敌对种类(enemies.ts)/派系袭击(raider def)/采集目标(growable+harvest)/采后瓦片(harvestReplaces)/光环(aura.radius)/AI 建造成本(def.cost)/出生建筑(tuning) 全部走 defs/tuning/registry，mod 不改内核（DATA_DRIVEN.md §6） |
| 存档健壮性 | §5 | ✅ | save/load JSON-safe：slots 存卡 id 还原（不再存闭包）、load 重建成员归属防假团灭、修复重建时 splice 跳杀残留 pawn |
| P1 server 骨架 | §5/§8/§9 | ✅ | **权威在 server**：Node 复用 `src/sim`（零 DOM ✓ tsx 直跑）+ WSS 通道；协议 `src/shared/protocol.ts`（welcome 全量 tile+defs 只读表 / 2Hz snapshot / tileChanged+feed 增量 / C→S 复用 Sim.Command）；server：固定步进 accumulator + `addTileListener` 增量推送（world.setTile 相同值去重不触发）；client：`?remote=ws://…` 连入，`RemoteSim` 实现与本地 Sim 同构读取面（world/pawns/建筑/需求/属性/欲望/卡池/事件），HUD+Renderer 双端共用；命令经 WSS 上行、server 权威执行、快照回显（e2e：scripts/e2e/remote-viewer.mjs 8 断言全过）。**断线重连（补强）**：client 指数退避自动重连（1s→2s→4s…封顶 15s）+ 首连失败明确报错（红屏提示配置错误）+ 顶部 reconnect hint（`remote-hint`）；**看门狗兜底**：connected 后 5s 无任何消息即判定 server 假死/网络黑洞 → 主动断开重连（不依赖 TCP 超时，`RemoteSim.watchdogMs` 可调）；server kill/重启 e2e 冒烟页面自动恢复（reconnect.test.ts 6 用例） |
| tick delta 增量 | §8/§9 | ✅ | **快照增量（P2 第一块）**：`src/server/diff.ts` 纯函数对比相邻快照 → 只发变化（`DeltaMsg`）：pawn 按 eid 逐字段 diff（x/y/hp/job/needs/faith/skills/slots/desires…）、新 pawn 首现必带 attrs、死亡 removed+pawnList；建筑按 key(y*width+x) 对齐 diff hp、拆除 removed；hostiles/stockpile/buildQueue 整体覆盖；全局字段各自携带。server：500ms 一轮 diff 广播 + 5s 全量对账（防增量丢失/相消漂移）+ 新连接先收全量底（广播过的快照即 diff 基线）；client：`applyDelta` 合并进 pawnCache/世界（读取面零改动，HUD/Renderer 无需区分）。12s e2e 实测 delta 26 帧 vs snapshot 4 帧（带宽 -90%）。测试：diff.test.ts 7 用例 + reconnect.test.ts applyDelta 1 用例 + scripts/e2e/remote-delta.mjs（帧构成/时间/位置断言） |
| 渲染插值 | §1/§8 | ✅ | **位置插值（渲染平滑）**：delta 500ms 一跳 → 渲染层 `interpPos`（pawn + 敌对）按 sim 时间线性插值（段起终点 + t0/t1，k 线性收敛）；`RemoteSim.renderNow()`：**播放时钟**——权威 t 锚定墙钟 + 帧间 extrapolate（speed 加权，paused 冻结），否则 time 只在消息到达时跳变、插值恒 k=1 失效；本地模式同样走插值（每 tick 段极短 ≈ 贴合真实）。顺带修复：死亡/重生 pawn 的渲染残留清理（delta 下 removed 广播后 sprite 及时移除，本地模式同受益）。e2e：scripts/e2e/remote-interp.mjs 采样 60 帧 sprite 位置出现 6-13 个渐进中间值（非 48px 跳变） |
| LLM 慢决策层 | §6/§10 | ✅ | **`LLM_ENDPOINT` 环境变量即启用**（OpenAI 兼容 chat completions）：`src/server/llm.ts` 预取模型（后台拉取 → 事件队列 → EventSystem 同步消费，失败指数退避降级确定性）；LLM 输出 JSON schema（name/text/effects）→ 白名单执行器（resource/mood/hp/recruit，数值钳制，**不进选择链路** ✓ DESIGN §6）；世界摘要随请求携带；`SimOptions.eventProvider` 构造注入。冒烟：mock LLM → server → feed 广播 `🎁 获得 ore 10 ✨ 星陨之夜` |
| 命令权威校验 | §8/§9 | ✅ | **联机安全（P2 前置）**：server `src/server/cmdValidate.ts` 把关上行命令——类型白名单/形状/坐标越界/建筑与职业存在性/`pawnId` 存在性/令牌桶频率（30 条/s，per-client 连接级）；非法命令丢弃并记录（不踢连接）；client 的 build/oracle/assign/move 显式带 pawnId（观察模式 server 无 selected 镜像）+ sim.issueCommand 的 assign 分支支持 pawnId。测试：cmdValidate.test.ts 5 用例 + viewer e2e 9 断言（build 回显 / move 指挥位移） |

## 待办 / 差距

> 旧条目若已在上表 ✅ 则移除；以下为当前真实差距（按优先级排序，2026-08-10 核）。

| 项 | 目标（DESIGN） | 差距 |
|---|---|---|
| client 层数据驱动 UI | §7 分层原则（服务端 mod 逻辑 + 客户端 mod 表现） | ✅ **已打通**：建造菜单遍历 `sim.mods.buildings`、tile 渲染查 `sim.mods.tiles`（未知 id 兜底色不崩）、tile/建筑图标可 `sprite` 声明复用素材、敌人按 enemyId 散列着色；`?mods=url` 运行时加载 ESM mod（demo: src/mods/demo-berry.ts，e2e: scripts/e2e）。剩余：mod 自带上传 SVG 素材管线未做（暂复用内置 sprite） |
| 闭合类型开放 | §7 mod 扩展 | `BehaviorCard.series`/`DesireId` 已开放为 string + `BehaviorCard.desire`(欲望关联)、`satisfies` 已有；新增 `ModRegistry.registerDesire(id,label)`（新欲望维度自动进循环：初始/衰减/匮乏/恶意/满足）；**`BehaviorIntent.action`/`UnitLevel` 已开放为 string**（`registerIntent(id, executor)` 全链路：mod 卡 decide 产出任意 action → 行为系统 Map 分派；`registerUnitLevel(id, capacity)` 新派系等级 + 记忆/看法容量，未知等级回退最小容量）；HUD 欲望显示遍历 DESIRES 表。mod 通路测试：自定义 intent 卡全链路执行 + temple 等级容量 20 |
| 插槽保底 | §6 插槽 | ✅ **已修**：initSlots 保底 3 张基础卡（eat/rest/chop），maxSlots=2+2trait 不再"永久闲逛"（曾实测）；HUD 文案改为「卡池 n 张（槽 m）」 |
| 丢失 chew：出生点/野营 'campfire'、派系掠夺者已数据化 | §7 | 出生建筑已读 `autobuild.starterBuilding`；`scripts.spawnWildCamp` 仍写死 'campfire'（语义上"野生营地=篝火"成立，暂留） |
| 流言/对话完整 | §6 | 微互动已做（模板）；**话题沿社交网络传播已落地**（2026-08-12）：小人记住听到的八卦（`gossip` 字段），TTL 内（`social.gossipTtl` 60s，`gossipChance` 0.7）转述给下一个相遇者，`gossip_spread` 事件可观测，确定性模板（零 LLM）；剩余：闲聊/深聊（引用记忆的 LLM 对话）待 P1 |
| 七宗罪欲望完整 | §3 欲望系统 | ✅ **七途径全通**（2026-08-12）：暴食(进食)/懒惰(休息)/贪婪(工作 satisfies)/暴怒(战斗+恶意槽)/傲慢(祈祷) + **色欲**（正向社交互动，`social.lustFulfillPerInteract`）+ **嫉妒**（存在更强同伴时完成劳动，`desire.envyFulfillPerWork`，skillTotal 标杆） |
| COC 属性全用途 | §3 属性卡 | ✅ **SIZ 负重已落地**（2026-08-12）：采集一次搬回量 = `carryBase + max(0, SIZ-strBase)×carryPerSiz`（tuning.gather，默认 4/0.5），矿洞/采矿/伐木产出统一钳制（保底 1），与 STR 产出加成互补；单测 + 集成测试（`carryCapOf`/`capGainTo`） |
| LLM 层 | §6 | ✅ **已落地**：server `LLM_ENDPOINT` 即启用（OpenAI 兼容），预取+白名单效果+降级（见上表）；剩余：真实 LLM 冒烟（本机无出网 key）、provider 频率分级（付费/免费，DESIGN §10）、LLM 叙述进"历史/记忆"而非仅 feed |
| server 增量优化 | §8 | P2 继续 | ✅ **tick delta 已落地**（500ms 增量 + 5s 对账，见上表）；剩余：实体事件化推送、chunk 按需、插值、兴趣管理、客户端权威提交验证待 P2 联机 |
| mod 打包/沙箱 | §10 待定 | 远程 JS mod 已落地（`?mods=` + ESM default 导出，见 src/mods/demo-berry.ts）；打包格式（zip/远程 URL 批量）、服务端沙箱/信任模型待定 |
| 联机 | §8 | P2：WSS 协议、多客户端同步、兴趣管理、持久化、鉴权 | ✅ 命令权威校验已提前（见上表）：形状/范围/pawnId/频率把关 + e2e 断言；剩余：多客户端、兴趣管理、持久化、鉴权 |

## 技术栈

- Vite + TypeScript + PixiJS v8 + bitecs ECS（SoA）+ vitest
- sim = 纯 TS 双端共用（`src/sim/` 零 DOM/PIXI），P1 起 server 直接 import
- 确定性：SimRng（种子化）+ 固定系统顺序 + 独立 world chunk 生成

## 存档注意

- IndexedDB 库名 `infcanvas-db`，store `saves`，key `autosave`
- 旧 localStorage `infcanvas-save*` 已不再读写（版本切换，旧存档作废）
