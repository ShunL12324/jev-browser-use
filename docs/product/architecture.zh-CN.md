# Jev + LLM 混合 browser-use MCP 服务：产品架构设计

状态：设计稿，等待 design gate，**尚未实现**。基线 `main` = `d2316c7`。本文没有发起付费调用；所有数字都来自已有 trace、仓库代码或下列参考仓库的公开测量。

目标：调用方（Claude Code）通过 MCP 给出自然语言任务，服务在用户 Chrome（经本项目扩展）中完成任务并返回结果。每步的快速决策由服务内的 Jev 完成，只有在 Jev 本质做不到或不确定时才用 LLM。**默认 LLM 就是调用方 Claude Code 本身**（handoff），不需要 `ANTHROPIC_API_KEY`；服务内置 provider 只是可选项（用户决定，2026-09-24）。目标成熟度：覆盖约 95% 的常见真实场景（以 T33 能力清单为尺），而不是 100%。

## 0. 竞品分析与定位

### 0.1 jev-ultrafast（主要参照，`/tmp/jev-ultrafast` @ `1231850`，只读）

约 850 行 Python/JS，全部读过：`agent.py` 174、`model.py` 198、`questions.py` 26、`browser.py` 194、`snapshot.js` 107，另读 `docs/design.md`、`docs/performance.md`、`docs/performance-prepared.md` 和 `tests/test_agent.py`。

**它实际怎么做**

| 环节 | 代码事实 |
| --- | --- |
| 观察 | `snapshot.js` 在一次 `Runtime.evaluate` 中同步读取可见的常见 HTML/ARIA 控件、名称、值、checked/selected/expanded，以及视口内可见文本（≤6000 字符）。WeakMap 给真实节点分配代码自有 ID；最多保留 250 个动作，超出的部分**截断且不可选**。不进入 shadow root 和 iframe；`password`、`file`、`hidden` 输入被排除。 |
| 动作空间 | `model.py:action_space`：每个节点一个索引；操作为 `CLICK`、`TYPE_TEXT`、`SELECT`、`SCROLL_UP/DOWN`、`WAIT`、`DONE`、`BLOCKED`。原生 select 的每个 option 都是 `SELECT` 头里的独立目标（`index:n`）。 |
| 决策 | `model.py:choose`：**一次** TypeSafe 请求，包含 `operation` Choice，以及每种可用操作一个 `<op>_target` Choice（speculative fan-out）；只消费与选中操作对应的目标头。**没有概率门槛**，直接执行 argmax；`validate_choice` 只校验答案形状。 |
| 文本 | 只有 `TYPE_TEXT` 调小 LLM（`field_text`，OpenAI 兼容，JSON `{text}`）。上下文为目标、字段、可见文本和近期动作。页面陈旧重试时，只有输入完全相同才复用生成的值。 |
| 执行 | CDP（browser-harness，需要 Chrome 远程调试）：`Input.dispatchMouseEvent` 真实点击、全选加 `Input.insertText` 输入、原生 select 直接设值并派发事件。执行前重新取几何并做 `elementFromPoint` 遮挡检查。 |
| 新鲜度 | 语义守卫：点击/选择只比较 document、URL、滚动、视口、表单值和目标的邻近上下文（form/dialog/row 的 innerText），不比较无关 DOM 变动；输入、滚动和完成用完整语义 marker。 |
| 等待 | 动作后最多等 2 个 animation frame 或 50 ms；可编辑 combobox 等候选项出现，上限 200 ms；显式 WAIT 为 100 ms。靠 `Emulation.setFocusEmulationEnabled` 让后台 tab 的 rAF 不被节流。 |
| 完成 | `DONE` 由模型选择，README 明说 DONE 不是成功证据，成功靠独立检查。60 个动作、120 个请求为硬上限；连续 3 次页面无变化则 blocked。 |

**公开测量**（其 `docs/performance.md`，非我们复现）：Google Flights 单程搜索，中位 7.09 s（3/3，6 次交替配对）。每次 17 个 Jev 请求，中位 178 ms/请求，每次运行约 90.6k 输入 tokens（约 5.3k/请求），2 次文本 LLM 调用。Wikipedia 打开指定条目 2.80 s；本地酒店搜索与过滤 1.90 s。作者自己说明样本太小，不是可靠性基准。

**明确不支持**：shadow root、iframe、canvas、上传、弹出 tab、嵌套滚动、任意键盘控件、MCP 接口、非 CDP 浏览器。它运行在已有 Chrome profile 中，需要开启远程调试。

### 0.2 其它同类（简述；依据公开文档/仓库，版本未钉，未在本任务中重跑）

| 产品 | 决策方式 | 浏览器层 | 与我们的差别 |
| --- | --- | --- | --- |
| browser-use（Python） | 每步由通用 LLM 看带索引的 DOM 元素（可选截图）并输出动作 JSON | Playwright/CDP | 全能但每步都是一次大 LLM 调用，成本和延迟高；我们用 Jev 取代大部分这类调用。 |
| Playwright MCP（Microsoft） | 无内置决策：调用方 LLM 每步读取无障碍快照（带 ref）并调用 click/type 等工具 | Playwright；也可通过扩展连已有浏览器 | 与我们现有 18 个 `browser_*` 工具同类。调用方每一步都要一个完整回合；我们的 `browser_task` 把这些回合换成服务内的 Jev 循环。 |
| Stagehand（Browserbase） | `act`/`extract`/`observe` 原语由 LLM 解析，可缓存动作；另有 agent 模式 | Playwright/CDP | 同样以 LLM 为核心决策；缓存思路可借鉴（见 §2.6）。 |

### 0.3 我们采纳什么、保留什么、在哪里必须可测地更好

**采纳（来自 jev-ultrafast，证据充分且和我们的失败经验一致）**

1. **一次请求 = 一个决策周期**：`operation` 头加上每种操作的 `target` 头（fan-out），再加我们已验证的每值 `bind` 头（form_batch，见 §2）。
2. **不用站点声明的目标**：每节点一个索引，各操作头只列兼容元素（§3）。
3. **事件驱动的短等待**取代固定延迟。依据：我们 r2 复杂表单主例 12.96 s 中，43 步 × `delay(120)`（`packages/bridge/src/jev/s1.mjs:298`）≈ 5.2 s 是固定等待，模型 6.56 s，浏览器调用只有 1.14 s（trace 汇总见 `/tmp/jev-complex-forms/round4-r2-case-1.json`）。按 2 rAF/50 ms 计，同一流程可省约 4–5 s。
4. **语义新鲜度守卫**：点击只比较目标及其邻近上下文，不把无关的异步变化当作陈旧。我们在 r1–r3 都遇到过异步有效性变化触发 `STALE_REF`，因为执行器比较的是完整 facts JSON（`packages/extension/src/content-scripts/s1.ts` execute 段）。
5. **只发可见文本**并限制大小；文本值生成的缓存/复用规则。
6. **只把执行记录写入历史**，DONE 不是成功证据。

**保留并且更强（它没有或做不到）**

| 我们的能力 | 代码依据 |
| --- | --- |
| 扩展而非远程调试：无 debugger 权限、无调试信息栏，直接用用户的 Chrome 会话 | `packages/extension/manifest.config.ts` 权限列表 |
| iframe（含跨域）：所有 frame 注入 content script，snapshot 按 frame 扇出，ref 形如 `fN:eM` | manifest `all_frames:true`；`lib/snapshot.ts`、`lib/frames.ts` |
| closed shadow DOM：`chrome.dom.openOrClosedShadowRoot` | `content-scripts/shadow.ts` |
| 上传：宿主授权的 fileId，字节不进模型 | `jev/s1-service.mjs:authorizeFile` |
| 多 tab、alert/confirm/prompt 捕获、网络日志 | `lib/tools/tabs.ts`、`content-scripts/main.ts`、`network-patch.ts` |
| 可验证的完成：范围化 UI 断言 + 独立 oracle，不重放、poison gate | `jev/s1.mjs:verify`，§1–§5 of `docs/s1-protocol.zh-CN.md` |
| 多值同页绑定：每值独立一题，真实 Jev 4/4 通过复杂表单（32/32+PDF，16 请求，13.0–13.9 s） | `jev/s1.mjs:compileBatch/decideBatch`，`/tmp/jev-complex-forms/round4-report.md` |
| MCP 接口 + 调用方 LLM handoff，不强制额外 key | 本文 §1 |

**必须可测地超过它的地方**（都在 T33 统一套件和同一台机器上，用各自的适配器跑；计时边界见 §6.4）

| 维度 | 目标 |
| --- | --- |
| 速度 | 共享任务（其 Wikipedia 条目任务、本地酒店类过滤任务、Google Flights 只读搜索）交替运行，中位 `agentMs` ≤ jev-ultrafast，且不低于其成功率。TYPE_TEXT 对比时，我们用 provider 模式或调用方预给 `inputs`（§2.4）；handoff 模式单独报告。 |
| 覆盖 | 它不支持的类别（iframe、shadow、上传、弹出 tab/新窗口、嵌套/虚拟滚动、下载）在 T33 套件里有通过任务；它在这些类别的通过数按实际结果记（预期为 0，不预设）。 |
| 成功率 | 全套件（本地 + 公开只读）成功率高于它，且每个失败都有 trace 与根因。 |
| 请求数 | 每决策周期 ≤1 次 Jev 请求；复杂表单每页 1 次绑定请求（已达成）。 |

它比我们强、我们需要追的地方：单请求 token 更少（约 5.3k 对我们约 8.9k/请求，r2 平均 142k/16），以及事件驱动等待和后台 tab 不节流。后者对扩展是真实风险（§4.6）。

**不照搬的地方**：它 argmax 直接执行。我们的 0.6 门槛曾导致三轮失败（`docs/s1-protocol.zh-CN.md` 第一至第四轮），但无门槛又没有安全网。我们按动作可逆性分级（§2.3）：可逆动作取 argmax，低置信 handoff 给调用方而不是失败停机，不可逆动作一律确认。

**保持小**：像它一样，核心循环保持可通读。目标是 `agent/` 目录约 1000 行以内，循环文件 ≤250 行，不引入插件框架或 DSL。

## 1. MCP 工具面

### 1.1 高层工具 `browser_task`

```jsonc
// start
{"action":"start","goal":"…自然语言…","startUrl":"https://…",           // startUrl 可选：缺省用当前任务 tab
 "allowedOrigins":["https://www.google.com"],                           // 本任务授予的站点，必填（§4.1）
 "inputs":{"email":{"value":"a@x.test","purpose":"contact email"},       // 可选：调用方已知的值，无需目标
           "password":{"secretRef":"shop.password","purpose":"login"}},
 "files":{"cv":{"fileId":"resume-2026","purpose":"résumé"}},
 "irreversible":"confirm",                                               // confirm | deny
 "llm":"handoff",                                                        // handoff | provider | none
 "budgets":{"timeoutMs":180000,"maxSteps":80,"maxJevRequests":80,"maxHandoffs":6}}
// continue：回答一个 handoff
{"action":"continue","taskId":"t_…","handoffId":"h_…","answer":{…按 handoff.expects…}}
// status / cancel
{"action":"status","taskId":"t_…"}   {"action":"cancel","taskId":"t_…"}
```

每次调用都在一个运行段结束后返回：终止结果，或 `needs_input`（带一个 handoff）。服务在调用之间保持会话（任务 tab、观察、历史、预算），会话空闲 10 分钟后取消并释放。`start` 超时前没有终止时返回 `running` 和 `taskId`，调用方用 `status` 取结果（长任务不阻塞 MCP 调用）。

**Handoff 对象**（与 T33 harness 约定一致，§6.4）：

```jsonc
{"status":"needs_input","taskId":"t_…",
 "handoff":{"handoffId":"h_…","kind":"text|choose|extract|confirm|credentials|question",
   "question":"…","options":[{"id":"e12","label":"…","context":"…"}],   // choose/confirm
   "field":{"label":"Where to?","role":"combobox","value":""},           // text
   "observationSummary":{"url":"…","title":"…","visibleText":"…≤3000 字符","tabs":[…]},
   "expects":{"type":"object","properties":{"text":{"type":"string"}}}}} // 回答的 JSON Schema
```

| kind | 何时 | 调用方回答 |
| --- | --- | --- |
| `text` | 需要的文本不在 `inputs` 中（§2.4） | `{text}`，或 `{values:{fieldIndex:text}}` 一次给出本页多个字段 |
| `choose` | Jev 对可逆性 R2 动作不确定，或连续无进展（§2.3） | `{choice:id\|"none", hint?}` |
| `extract` | 任务要求回答问题、Jev 已选出证据块（§2.5） | `{answer, evidenceIds}` |
| `confirm` | 分类为不可逆（§4.2） | `{approve:true\|false}` |
| `credentials` | 需要 secretRef 却缺失 | `{secretRef}`（只给引用，不给明文） |
| `question` | BLOCKED/预算接近上限，需要方向 | `{answer}` 或 cancel |

默认 `llm:"handoff"`：调用方 Claude Code 回答 handoff，这是产品的主路径。可选 `llm:"provider"`：`text`/`choose`/`extract`/`question` 由服务调用配置的模型回答（需要 provider key；缺失时自动退回 handoff）。`confirm` 与 `credentials` **永远**回到调用方。`llm:"none"` 时任何 handoff 都以 `blocked` 终止（供测量 Jev 自主能力）。

### 1.2 结果

```jsonc
{"status":"done|blocked|needs_confirmation|cancelled|error","taskId":"t_…",
 "answer":"…","evidence":[{"tabId":1,"url":"…","blockId":"t17","quote":"…"}],
 "verification":"model_done|evidence_quoted|ui_assertions",   // 证据等级，不等于业务成功
 "finalUrl":"…","tabs":[…],"handoffs":[{"kind":"text","waitMs":…}],
 "metrics":{"agentMs":…,"navigationMs":…,"jevMs":…,"llmMs":…,"handoffWaitMs":…,"observeMs":…,"execMs":…,"settleMs":…,
   "jevRequests":…,"jevInputTokens":…,"jevUnknownUsage":…,"llmRequests":…,"llmTokens":…,"llmUnknownUsage":…,"steps":…,"stale":…,"recoveries":…},
 "tracePath":"…/traces/t_….jsonl"}
```

Trace 沿用 `s1-service.mjs` 的 JSONL：observation 摘要、每次 Jev 请求/回答/usage、决策与守卫结果、handoff 请求/回答（秘密脱敏）、执行、settle、终止。付费发送沿用 `budget.mjs` 的中央账本和原子占号。

### 1.3 低层工具

18 个 `browser_*` 工具不变，调用方随时可以直接操作；`browser_task` 运行时对它的任务 tab 加锁（现有 `gate.exclusive`），低层工具对其它 tab 照常工作。`jev_run`、`jev_run_s1` 保留为实验入口，产品文档不再推荐。

## 2. 决策循环与路由

### 2.1 一个周期

```
observe(任务 tab 集合, 所有 frame) → 元素表 + 可见文本块
  → 1 次 Jev 请求：operation 头 + 每操作 target 头 + 每待填值 bind 头 + done 头
  → 代码策略（可逆性门槛、冲突、预算） → 守卫 → 执行（可能是一批 bind）
  → 事件驱动 settle → 下一周期
```

**操作集**（每项都有 registry 声明的可用条件、执行器和后置检查，沿用 `s1.mjs:registry` 的做法）：`CLICK`、`TYPE_TEXT`、`SELECT`（原生 option 作为目标）、`SET_CHECKED`、`UPLOAD`、`PRESS_KEY`（有限集：Enter/Escape/Tab/方向键，作用于目标）、`HOVER`、`SCROLL`（页面或某个可滚动容器，容器是目标）、`SWITCH_TAB`、`CLOSE_TAB`、`GO_BACK`、`WAIT`、`DONE`、`BLOCKED`。`DRAG` 放在 P4（§6.3）。

**一次请求里的题目**：

| 题 | 类型 | 内容 |
| --- | --- | --- |
| `operation` | Choice | 本页可用的操作（只列有目标的）+ DONE/BLOCKED |
| `<op>_target` | Choice ×k | 每个可用操作一题，只列兼容元素（屏外元素带 reveal 标记，宿主先滚动，沿用 T1 r2） |
| `bind.<valueId>` | Choice ×n | 每个未施加的 `inputs`/文本值一题：候选 = 所有**兼容**字段（无声明目标）+ `not_now` |
| `done` | Noul | 当前证据是否表明整个目标已完成（只作信号） |

这是 jev-ultrafast 的 op+target 头加上 T1 的 bind 头。有接受的 bind 时，本周期只执行 bind 批次（按页面顺序、逐个守卫，任何变化即停，见 `s1.mjs:rebind`），忽略 operation。这正是 r2 复杂表单 16 请求完成 32 个值的机制。

### 2.2 哪些决策交给 Jev，哪些交给 LLM

| 决策 | 交给 | 理由 |
| --- | --- | --- |
| 下一操作、目标、值落在哪个字段、选哪个 option、是否施加 | Jev（Choice） | 有限候选，一次请求可并行 |
| 是否完成、动作是否会提交/支付/删除 | Jev（Noul）+ 代码规则 | 命题判断；不可逆分类还有代码特征兜底（§4.2） |
| 答案所在的文本块 | Jev（Choice，候选为代码切出的可见文本块） | 官方 pre-parsed value extraction 模式；不生成文本 |
| 要输入的自由文本（搜索词、城市、消息） | `inputs` → LLM | Jev 不生成文本 |
| 最终答案措辞 | LLM（或直接引用证据块） | 同上 |
| Jev 低置信、连续无进展、BLOCKED | LLM `choose`/`question` | 需要推理或额外信息 |
| 不可逆确认、凭据 | 调用方（用户） | 权限，不由模型决定 |
| 多步任务拆分 | 默认不拆：目标整体进入每次 Jev state（与 jev-ultrafast 相同）；调用方可以在 goal 里自己列步骤 | 避免每个任务多一次 LLM 往返 |

### 2.3 门槛与级联

动作按可逆性分级，由 registry 与代码特征决定，不由模型决定：

| 级别 | 例子 | 策略（初值，P1 校准） |
| --- | --- | --- |
| R0 只读/幂等 | SCROLL、WAIT、HOVER、打开折叠/菜单、SWITCH_TAB | argmax 直接执行 |
| R1 可逆输入 | TYPE_TEXT、SELECT、SET_CHECKED、bind | bind 沿用 p ≥ 0.6（r2 实测接受概率 0.91–0.99）；单操作 argmax 且 p ≥ 0.4 |
| R2 导航/非最终提交 | 链接、Continue、搜索按钮 | p ≥ 0.6 执行；低于则 `choose` handoff，列出前 5 项 |
| R3 不可逆 | 下单、支付、预订、发送、删除、最终提交 | 不论概率一律 `confirm`（§4.2）；`irreversible:"deny"` 时终止为 needs_confirmation |

说明：概率是候选间的相对偏好，不是准确率；这些数都是路由初值，不是校准结论。r2 已执行的导航最低只有 0.64–0.68，边际很薄，所以 R2 低于门槛时改为 handoff，而不是像旧 S1 那样 `UNCERTAIN` 失败。P1 用 T33 套件的真实运行，统计每级门槛下的错误执行率和 handoff 率，再定最终值；调整门槛必须附数据，不能静默修改。连续 3 个周期页面语义无变化（不计 WAIT）时，走 `choose`/`question` handoff 一次；之后仍无进展则 blocked。

### 2.4 文本从哪里来（handoff 最小化）

handoff 一次就是调用方的一个完整回合（数秒），是速度的最大风险，所以按下面顺序取值：

1. `start.inputs`：调用方通常已经知道这些值（Claude Code 读过用户请求），可以在 start 时一次给出，没有 handoff。bind 头负责把值放进正确字段，**不需要声明目标**。
2. 字段级缓存：同一任务里同一字段语义（label+role+context）已经生成过的值。
3. 一页一次：本页出现第一个需要文本且没有来源的字段时，**一次** `text` handoff（或 provider 调用），列出本页所有未填的文本字段，请求 `{values:{fieldIndex:text}}`。得到的值变成 `inputs` 条目，仍由 bind 头决定施加。jev-ultrafast 是每个字段一次 LLM 调用；这样每页最多一次。
4. 生成的值和 jev-ultrafast 一样严格校验：字符串，≤2000 字符，不含控制字符；缺失时为 null，不猜测。

### 2.5 信息查找与答案

目标需要回答时（由 goal 的 `done` Noul 和调用方意图决定；`start` 可带 `answerFormat`），代码把可见文本切成块（段落、表格行、列表项、描述列表，每块 ≤400 字符，带 blockId）。与 operation 同一次请求里加一道 `answer_block` Choice（候选为块 + `not_here`）。选中后：provider/handoff 模式由 LLM 用选中的块写答案（`extract` handoff 附带块原文）；`llm:none` 模式直接返回块原文作为答案。结果带 `evidence` 引用，`verification:"evidence_quoted"`。跨页收集（比较多个结果）在历史中保留已选块，最多 20 块。

### 2.6 成本与延迟预期

| 项 | 预期 | 依据 |
| --- | --- | --- |
| Jev 请求 | 180–450 ms，5–9k 输入 tokens | ultrafast 中位 178 ms/5.3k；我们 r2 约 410 ms/8.9k |
| 观察 | 5–15 ms/次（top frame），多 frame 扇出 +每 frame 5–15 ms | r2 observe 0.47 s / 约 60 次 |
| 执行 | ~10 ms/次 | r2 exec 0.41 s / 43 步 |
| settle | 0–50 ms（combobox ≤200 ms） | 采纳 ultrafast |
| provider 文本 LLM | 350–600 ms（小模型） | ultrafast 记录 Mercury 346–581 ms |
| handoff | 调用方回合，2–10 s | 估计，P1 测量 |

复杂表单按这些预期：16 × ~0.4 s + 43 × 0.05 s ≈ 8.6 s，现在是 13.0 s。缓存（Stagehand 思路）：同一站点同一页面结构上的动作序列暂不缓存，因为正确性风险大于收益；作为 P5 以后的选项。

### 2.7 Jev 的限制（照实写，决定设计边界）

- 不生成文本，所以文本来自 `inputs`/LLM；答案用证据块。
- 请求总计 ≤64k tokens，state 加最大单题 ≤32k；Choice ≤255 项。超出按 §3.3 分层，不静默截断。
- 只接受文本，没有视觉：canvas、图表、纯图标按钮无名称时不可用（名称回退到 title/alt/aria），属于 5% 的范围。
- 易受页面文本注入影响：页面文字是不可信数据，Jev 判断不是权限边界；站点许可、不可逆确认和秘密处理都由代码强制（§4）。
- 概率不是正确率；门槛只做路由。

## 3. 无声明目标的目标发现

### 3.1 元素表

每个可交互节点一个索引（跨 frame 形如 `f3:e12`，沿用现有 ref）。字段包括：role、name（现有 `deriveName`，含 labelledby/label/aria-label/title/placeholder）、value/checked/selected/expanded/disabled/readonly/required/valid、所属 frame 和 tab、语义上下文（fieldset legend、group/row/dialog/listbox 名称，现有 `s1.ts:facts`）、是否在视口内、可用操作列表。可编辑字段同时提供 TYPE_TEXT 和 CLICK（打开），和 ultrafast 一样。

### 3.2 值 → 字段

`bind.<valueId>` 的候选是所有兼容字段：文本值对应可编辑字段，布尔值对应 checkbox/radio/switch，选项值对应其 option 包含该值（精确或规范化后相等）的 select/listbox。题目给出 purpose、值、字段 label/context/当前值。这替换了 `s1.mjs:matchesTarget` 的精确声明匹配（T1 的已知限制：r2 所有 128 道 bind 题都只有一个候选）。T1 已有的冲突规则（同一目标被多个值选中则全部丢弃）、逐个守卫和批次停止规则保持不变。重复字段（多行经历）靠 context 区分，Jev 看得到 context；同名同 context 的对象仍标记为 ambiguous，不提供（`adaptObservation`）。

### 3.3 候选预算

- 默认只列视口内及附近（±1 视口高度）的元素；屏外元素带 reveal。
- 每个 target 头 ≤254 项。超出时，本周期改为两阶段：先用一次请求做 `region` Choice（landmark、section、form、dialog、frame、可滚动容器，每个带摘要），再在选中区域内做 op+target。这只在大页面发生，费用是多一次请求，写入 trace。
- 请求字节 ≤48 KB（现有 guard）。state 只放可见文本（≤6000 字符，同 ultrafast）和元素表的精简字段；r2 的 facts 冗余要去掉，目标是 ≤6k tokens/请求。
- 永不静默丢弃：被省略的数量和原因进入 state，模型能选 SCROLL/region 去看。

### 3.4 新鲜度守卫（替换完整 facts 比较）

采纳 ultrafast 的分级守卫：CLICK/SELECT 比较 documentId、URL、目标身份/role/name/value/state，以及邻近 form/dialog/row 上下文文本的哈希；TYPE_TEXT/SCROLL/DONE 比较完整语义 marker。执行前总是重新取几何并做命中测试（现有 `centerReachable`）。保留现有的 document token、同步检查后派发、不重放、传输丢失即 poison 的规则。

## 4. 安全

### 4.1 站点许可

`allowedOrigins` 在 `start` 时必填（支持显式 `https://*.example.com`）。`s1-service.mjs:assertS1Origin` 的 17430/17431 锁去掉，只有测试夹具继续使用。导航或新 tab 到许可之外：只读 GET 导航（链接）用 `confirm` handoff 申请加入许可；表单提交、请求到许可外一律拒绝。许可只在本任务会话内有效。

### 4.2 不可逆动作

分类同时使用代码特征和 Jev，任何一方认为不可逆就确认（宁可多问）：

- 代码特征：所在 form 包含 password/支付卡字段；按钮 type=submit 且是多步流程的最后一步（没有后续步骤指示）；名称或邻近文本匹配多语言关键词表（buy、pay、place order、book、confirm、send、delete、remove、unsubscribe、提交、支付、下单、删除…）；`window.confirm` 被触发。
- Jev：同一请求内的 Noul：“执行这个目标会提交交易、发送消息、删除或产生不可撤销的外部效果吗？”（只对 R2 候选中的前几个问，控制题数）。
- 确认时 handoff 给出动作、目标、所在页面、将提交的字段值（秘密脱敏）。批准只对这一次动作有效。`window.confirm`/`alert`/`prompt` 的已有 MAIN world 覆盖（`content-scripts/main.ts`）改为：确认对话框按不可逆处理。

误判的代价不对称：漏判就是真实后果，所以 P3 评测要报告漏判率，要求为 0（每个不可逆提交都必须先有确认，T33 站点记录提交时间戳，§6.4）。

### 4.3 秘密与凭据

`inputs.*.secretRef` 由宿主从秘密清单解析（与文件 manifest 同一机制）。明文只在执行请求中出现一次，不进入 Jev state（显示为 `‹secret:shop.password›`）、LLM 上下文、handoff、trace 或结果。password 字段只能由 bind 施加 secretRef 值，不能 TYPE_TEXT 生成值。T33 harness 会扫描所有输出中的明文，发现即判失败。

### 4.4 页面内容

页面文字、标题、URL 都是不可信数据，所有题目都带不可信声明（沿用 `s1.mjs` 的 `rule`）。模型输出只能是候选 ID，不能变成选择器、坐标、URL 或 JS。`eval_js`、`request`、`get_cookie` 不在 `browser_task` 的操作集里。

### 4.5 预算

每任务限制：Jev 请求、Jev 输入 tokens、LLM 请求/tokens、handoff 次数、步数、墙钟。产品开发与测试用**新的中央账本**（例如 `/tmp/jev-product/live-budget.json`，与 complex-forms 的 240 账本分开，沿用 `budget.mjs` 的原子占号和“失败也计数”）。用户已放开规模：每累计 1000 次向 master 报告，10000 次硬停，除非 master 上调；没有自动重试循环。产品模式下账本是可选的本地计费记录。

### 4.6 用户浏览器的风险

- 实际运行环境是用户的 Windows Chrome（已登录各种账户），扩展手动加载；bridge 在 WSL 的 127.0.0.1:17329（mirrored 网络，Windows 可访问 WSL 的 localhost 测试站，master 已于 2026-09-24 验证）。任务 tab 由服务在**专用窗口**中创建，并放进一个 tab group；服务只操作自己的 tab，绝不读写其它 tab、cookie 或已登录账户。公开站点只读，不提交。用户手动在任务 tab 上操作时，守卫会检测到变化并停止或重新观察。
- `browser_task` 的操作集不包含 `get_cookie`、`eval_js`、`request`；低层工具仍然存在，需要调用方自行克制。评测期间 tester 只用 `browser_task` 和只读低层工具。
- **后台 tab 节流**：扩展没有 CDP 的 focus emulation。后台 tab 的 rAF 会暂停，定时器被节流，settle 和动画可能变慢。计划：P1 测量后台 tab 与独立非聚焦窗口的 settle 时间；需要时 settle 改用 MutationObserver 加 `setTimeout` 上限，而不依赖 rAF。
- **合成事件**：content script 派发的事件 `isTrusted=false`，少数控件（部分日期选择器、依赖指针事件的拖拽、剪贴板）会拒绝。可选的后备方案是 `chrome.debugger` 的 `Input.dispatch*`，代价是出现调试信息栏，而且需要新增权限。默认关闭，由用户显式开启；T33 中需要可信事件的任务单独标注。

## 5. 多 tab、iframe、新窗口、虚拟列表、下载与上传

| 能力 | 现状 | 设计 |
| --- | --- | --- |
| iframe（同源/跨源） | snapshot 已按 frame 扇出（`lib/snapshot.ts`）；S1 observe 只看 top frame（`content-scripts/s1.ts:handleS1`） | S1 观察改为每 frame 一个 documentId，元素表合并；frame 本身不可见则其内容不可见；命中测试在 frame 自己的视口内进行，并检查 iframe 元素在父文档中可达 |
| shadow DOM（含 closed） | walker 能进入（`shadow.ts`）；S1 把 `shadowContext` 标为不可用（`s1.mjs:available`） | 允许在 shadow 中执行：命中测试用 composed path；断言仍然只对可证明的范围给出 absent |
| 多 tab、新窗口、弹窗 | `tabs` 工具有 list/new/switch/close | 监听 `chrome.tabs.onCreated`：`openerTabId` 属于任务 tab 集合的新 tab 自动纳入任务；元素表带 tab 标签，`SWITCH_TAB` 目标为任务 tab；结束时关闭任务创建的 tab（可选保留） |
| 对话框、alert、cookie 横幅 | MAIN world 覆盖 alert/confirm/prompt | alert 内容进入观察；confirm 按 §4.2 处理；prompt 需要文本时走 §2.4；cookie 横幅是普通 CLICK 目标，规则里写明“遮挡目标的横幅可以关闭（优先拒绝非必要 cookie）” |
| 虚拟/无限列表、嵌套滚动 | 无 | 检测可滚动容器（overflow auto/scroll 且可滚动）作为 `SCROLL` 目标；观察标出“容器还有更多内容”；抽取时按内容键跨滚动去重 |
| 分页 | 普通链接/按钮 | 无特殊代码；抽取历史跨页保留 |
| 下载 | 没有 `downloads` 权限 | 新增 `downloads` 权限：`chrome.downloads.onCreated/onChanged` 跟踪任务 tab 触发的下载，结果返回文件名、大小、MIME、sha256，内容不进模型 |
| 上传 | 宿主授权 fileId → `actSetFiles` | 沿用。MCP 可以直接传 base64 文件内容（现有 `browser_upload_file`）或 manifest fileId |
| hover 菜单 | `hover` 工具派发鼠标事件 | `HOVER` 作为 R0 操作 |
| 键盘控件 | `press_key` 工具 | `PRESS_KEY` 有限键集，作用于目标（带焦点） |
| 拖拽 | 无 | P4 用合成 pointer/drag 事件；不可靠时需要 §4.6 的可信事件后备 |

## 6. 迁移、模块与分阶段计划

### 6.1 复用与替换

| 复用 | 替换 |
| --- | --- |
| 扩展全部 content scripts、refs、frame 扇出、shadow、动作、网络捕获；WS bridge；MCP 注册；`budget.mjs`；trace 服务；`s1.ts:facts`；`verify`；form_batch 的 bind/冲突/rebind/reveal 逻辑；上传授权 | 声明目标（`targetSchema`/`matchesTarget`）→ 无目标 bind；单一 Choice `compile` → op+target+bind 头；`delay(120)` → 事件 settle；完整 facts 比较 → 分级守卫；top-only observe → 多 frame/tab；端口锁 → 任务许可 |

S1 与 `form_batch` 保留为已测的实验入口与回归测试（`tests/jev-s1*.test.mjs`、`tests/e2e/*`），新代码不修改它们的行为。

### 6.2 模块布局（`packages/bridge/src/agent/`）

| 文件 | 职责 | 目标行数 |
| --- | --- | --- |
| `task.mjs` | `browser_task` schema、会话表、预算 | ≤150 |
| `observe.mjs` | 多 frame/tab 观察 → 元素表 + 文本块；守卫 marker | ≤200 |
| `space.mjs` | 操作 registry、兼容性、分级、候选预算/region | ≤200 |
| `jev.mjs` | 组装一次请求（op/target/bind/done/answer）与答案校验 | ≤150 |
| `loop.mjs` | 周期、策略、批次执行、settle、终止 | ≤250 |
| `handoff.mjs` | handoff 与 provider LLM（同一接口） | ≤150 |
| `safety.mjs` | 许可、不可逆分类、秘密解析/脱敏 | ≤150 |
| `mcp.mjs` | 注册 `browser_task` | ≤80 |

扩展侧：`content-scripts/s1.ts` 扩展为多 frame 观察、shadow 执行、settle 等待（新消息 `settle`），`service-worker` 增加 tab 归属和下载跟踪。

### 6.3 分阶段计划

T33 的能力清单 ID 还没冻结，下表先用类别代号，冻结后逐项映射（由 form-validator 在 `docs/eval.zh-CN.md` 给出权重和 ID）：NAV 导航/搜索、EXT 抽取/回答、FN 原生表单、FC 自定义控件（combobox/自动完成/日期/富文本）、UP 上传、AUTH 登录、TXN 购物车/结账/预订确认、TAB 多 tab/新窗口/弹窗、IFR iframe、SHD shadow、VL 虚拟/无限列表、NS 嵌套滚动、DLG 对话框/alert/cookie、DL 下载、HOV hover、KEY 键盘控件、DRG 拖拽、PG 分页、ERR 错误/重试页、SLOW 慢加载。

每阶段都按同样顺序证明：离线单测 → T33 本地站机械回放（deterministic 应答，只证明管道）→ 真实 Jev（由 validator 在冻结 SHA 上跑，预算事先批准）→ 公开只读任务。成功只以独立 oracle 为准。

| 阶段 | 内容 | 覆盖类别 | 验收（证明方式） |
| --- | --- | --- | --- |
| P1 核心循环，追平再超越 ultrafast | `browser_task` start/continue/status/cancel；无声明目标的元素表；op+target+bind 头；事件 settle；分级守卫；handoff `text/choose/question`；许可；top frame + shadow；bridge hub 模式（§6.5）；专用窗口/tab group；新产品账本 | NAV、FN、FC(部分)、SHD、DLG(cookie) | T33 共享任务（Wikipedia 条目、本地酒店类过滤、Google Flights 只读）与 jev-ultrafast 在同机交替运行：成功率 ≥ 对方，中位 agentMs ≤ 对方；复杂表单**不声明目标**、只给 inputs：4 个 reset 中 ≥3 次 oracle 32/32+PDF，Jev 请求 ≤18，agentMs ≤10 s；门槛校准报告（每级错误执行率与 handoff 率） |
| P2 多上下文与回答 | 多 frame 观察/执行；tab 归属、新窗口、弹窗；alert/confirm；分页；`answer_block` + `extract` | IFR、TAB、DLG、PG、EXT | T33 iframe 站（同源+跨源）、弹窗站、分页抽取站：每项 ≥4/5 通过，且在 held-out 布局上 ≥3/5；答案任务由站点 grade 端点判分 |
| P3 账户与交易 | secretRef 登录；购物车/结账/预订到确认；不可逆分类；下载/上传 | AUTH、TXN、DL、UP | 不可逆漏判 0（每次提交前都有确认 handoff，站点时间戳为证）；`deny` 任务无提交；秘密泄漏 0（harness 扫描）；交易类 ≥4/5 |
| P4 困难控件 | 虚拟/无限列表、嵌套滚动、日期选择器、富文本、hover 菜单、键盘控件、拖拽（尽力）、慢加载/错误重试；provider 模式 | VL、NS、FC、HOV、KEY、DRG、SLOW、ERR | 每类 ≥1 个本地站任务，≥4/5 通过；拖拽和需要可信事件的任务单独报告，允许标为 known-limit |
| P5 成熟度 | 公开只读套件；held-out 变体；token/速度优化；文档 | 全部 | 见下 |

**“95%” 的可检验定义**（提议，需 master 与 form-validator 确认）：T33 清单按常见程度加权。加权 ≥95% 的清单项在 held-out 任务上达到 ≥4/5 成功，其余项有明确的 known-limit 说明（例如 canvas、CAPTCHA、需要视觉的任务）。全套件（本地 + 公开只读）总成功率 ≥90%，且每个失败都有 trace 与根因分类。速度：共享任务中位 agentMs 不慢于 jev-ultrafast。

### 6.4 与 T33 的评测接口（已与 form-validator 约定）

- **两个视图**：runner 只收到 `{id, startUrl, goal, inputs, files, allowedOrigins, irreversible, budgets}`。oracle、capabilities、heldOut、期望答案都不给 runner。
- **本地站端点**：`POST /__eval/reset {seed,variant,taskId} → {runId,url,inputs?}`、`GET /__eval/oracle/{runId}`、`POST /__eval/grade/{runId} {answer}`（期望答案不离开站点）。complex-forms 继续用 `/api/reset`、`/api/oracle`，通过 task 的 reset/oracle 字段配置。
- **Runner 适配器**：`run(runnerView, {handoff}) → {status, answer?, finalUrl, tabIds, metrics, tracePath}`。handoff 请求为 `{kind, question, options?, observationSummary?, runId}`，回答为 `{approve?|answer?|choice?}`。模式：`stub`（只做机械测试）、`scripted`（按 task.irreversible 回答 confirm、从 manifest 回答 credentials、其余拒绝，不花钱）、`llm`（付费计数）、`deny`。结果分“自主”（0 次开放式 handoff）和“辅助”两栏报告。
- **秘密**：secretRef 从 harness 秘密清单解析；harness 扫描 trace/结果/handoff 中的明文，泄漏即失败。
- **不可逆**：站点为每次提交记录服务器时间戳；harness 记录每个 confirm handoff 的时间。通过要求“已提交 == (irreversible=='confirm' 且批准)”，且 confirm 早于提交；`deny` 任务要求无提交，且状态为 needs_confirmation/blocked。
- **计时边界**：`agentMs` 从第一次决策到终止（与 ultrafast 一致，不含初始导航，含等待与 handoff 时间），`handoffWaitMs` 单列；`e2eMs` 从调用到 oracle 返回；另报 `jevUnknownUsage`、`llmUnknownUsage`，结果内写明边界定义。
- **jev-ultrafast 适配器**：包装其 `Agent(url, goal)`，指标直接映射（decisions、text_calls、usage）。它需要 harness 启动的 Chromium 的 CDP 端点；如果 browser-harness 不能指定 CDP URL，它只参加 answer/http-oracle 类任务（form-validator 核实）。

### 6.5 真实端到端测试方法（用户决定，2026-09-24）

- 专用测试目录放一个 `.mcp.json`，指向 `packages/bridge/dist/index.js`。master 在该目录启动一个 Claude Code tester 成员，tester **只通过我们的 MCP 工具**操作浏览器，并充当 handoff 的调用方 LLM。
- 浏览器是用户 Windows Chrome 中手动加载的扩展（dist 复制到 `C:\Users\Shun\jev-browser-use-extension`，更新时由 master 同步并请用户重新加载）。
- tester 的流程：读取 T33 的 runner 视图（不含 oracle），调用站点 reset 得到 `{runId,url,inputs}`，然后 `browser_task start` → 回答 handoff → 得到结果，把 `browser_task` 返回的 `metrics`、`taskId`、`tracePath` 与自己的 handoff 记录写进结果文件。**判分不由 tester 做**：harness 脚本（或 validator）按 runId 独立读取 oracle/grade，并交叉核对 trace 中的 Jev 请求数与中央账本。tester 看不到 oracle 与期望答案。
- 两种运行：tester 模式（真实 Claude Code 调用方，报告“辅助”成绩）；harness 的 `scripted`/`deny` 模式（无 LLM，报告“自主”成绩，也可在 WSL 的临时 Chromium 中跑回归）。

**17329 端口的共享**：现在一个 bridge 进程独占 17329，扩展只保留最新连接（`ws-host.ts` 遇 `EADDRINUSE` 直接失败；见 `docs/architecture.zh-CN.md` 已知限制）。每个 Claude Code 会话启动 MCP 时都会拉起自己的 bridge，所以 tester、master 和其它成员无法同时使用用户的 Chrome。设计：

1. **短期（P1 之前）**：由 master 串行分配。同一时刻只有一个会话的 `.mcp.json` 启用 bridge，其它成员用 WSL 临时 Chromium + 随机端口（现有机械测试的做法）。
2. **P1 内实现 hub 模式**：第一个 bridge 在 17329 作为 hub，同时接扩展；后来的 bridge 检测到 `EADDRINUSE` 后不再失败，而是以 client 身份连接 `ws://127.0.0.1:17329/peer`（本地 token 认证），把自己的 MCP 调用转发给 hub。hub 按会话记录 tab 归属：会话只能操作自己创建的 tab/窗口，`tabs list` 只返回自己的 tab；`browser_task` 的会话锁也按会话隔离。hub 退出时，client 自动接替（重新监听并等待扩展重连，扩展已有重连逻辑）。
3. 验收：两个 MCP 会话同时运行任务，互不看到或操作对方 tab；任一方退出后另一方在扩展重连后继续。

## 7. 非目标

CAPTCHA 与反机器人绕过；需要视觉的页面（canvas 应用、图像内容判断）；真实账户、真实购买或提交（评测只用本地站点与公开只读任务）；跨浏览器与移动端；远程/云端浏览器；自由对话式聊天；站点专用脚本或技能库（可作为 P5 以后的选项，但不进核心）。

## 8. 主要风险

| 风险 | 影响 | 缓解/检验 |
| --- | --- | --- |
| 无声明目标后 bind 变难 | T1 的成功依赖声明目标；真实 Jev 在多候选时的绑定准确率未知 | P1 第一项实验就是 complex-forms 无目标版本；失败则分析 trace，考虑用 label 相似度排序候选（仍由 Jev 选择），不回退到声明目标 |
| 导航概率边际薄 | r2 最低 0.64 | 分级门槛 + choose handoff；P1 校准 |
| handoff 延迟 | 调用方回合为数秒 | §2.4 inputs 优先、一页一次；报告自主/辅助两栏 |
| 后台 tab 节流、合成事件 | 速度与兼容性 | §4.6 测量；可选 debugger 后备 |
| 大页面 token | 超 32k/64k | 视口优先、region 两阶段、精简 facts |
| 提示注入 | 错误动作 | 代码层许可/确认/秘密；Jev 不是权限边界 |
| 使用用户真实 profile 的副作用 | 用户 Windows Chrome 已登录账户、历史、cookie | 专用窗口 + tab group、只操作自有 tab、`browser_task` 不含 cookie/eval/request 操作、公开站点不提交、测试站在 localhost；回归用 WSL 临时 profile |
| 端口 17329 单会话 | 多个成员无法同时测试 | §6.5：短期由 master 串行，P1 做 hub 模式 |
| 小样本结论 | 夸大能力 | 所有报告写 n、种子、held-out 强弱，失败保留 |
