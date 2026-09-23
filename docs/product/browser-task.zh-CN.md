# browser_task 使用说明（P1a）

`browser_task` 是 [产品架构设计](architecture.zh-CN.md) 的 P1a 实现：调用方用自然语言给出任务，服务内的 Jev 每个周期做一次决策，只有需要文本、确认或 Jev 不确定时才把问题交回调用方（handoff）。18 个低层 `browser_*` 工具、S1、form_batch、J0/J1 都保持原样。

## 启动

```sh
npm ci && npm run build
# bridge 读取 TYPESAFE_API_KEY；默认注册 browser_task，无需额外开关
node packages/bridge/dist/index.js
```

可选宿主环境变量：

| 变量 | 作用 |
| --- | --- |
| `JEV_PRODUCT_LEDGER` | 付费请求中央账本，默认 `/tmp/jev-product/live-budget.json`，硬限 10000 次，发送前原子占号，失败也计数 |
| `JEV_TASK_TRACE_DIR` | trace 目录，默认 `/tmp/jev-product/traces`（JSONL，秘密明文已替换为 `‹secret›`） |
| `JEV_SECRETS_MANIFEST` | `{ref: {value, origins: [...]}}`；task 只给 `secretRef`，明文只进入执行请求 |
| `JEV_S1_FILES_MANIFEST` | 与 S1 相同的 fileId → base64 文件清单；字节不进入模型 |
| `JEV_SOURCE_SHA` | 写入账本与 trace 的源码标识 |

## 调用

```jsonc
{"action":"start","goal":"Use the destination search and filters to find Design stays in Lisbon with Free cancellation, then open Casa Flora.",
 "startUrl":"http://127.0.0.1:17445/fixture.html?scenario=travel","allowedOrigins":["http://127.0.0.1:17445"],
 "inputs":{"email":{"value":"a@x.test","purpose":"contact email"},"pw":{"secretRef":"shop.password","purpose":"account password"}},
 "files":{"cv":{"fileId":"resume","purpose":"résumé PDF"}},
 "irreversible":"confirm","llm":"handoff","budgets":{"timeoutMs":300000,"maxSteps":120,"maxJevRequests":80},"waitMs":50000}
```

- 返回 `done` / `blocked` / `needs_confirmation` / `error`（终止），`running`（用 `{"action":"status","taskId"}` 继续等待），或 `needs_input`（带 `handoff`）。
- 回答 handoff：`{"action":"continue","taskId","handoffId","answer":{...}}`。`confirm` 回答 `{approve:true|false}`；`text` 回答 `{text}`；`choose` 回答 `{choice:"<option id>"}`（不在选项中视为拒绝）；其它不回答则视为拒绝并以 `blocked` 结束。
- `llm:"none"`：只保留 `confirm`/`credentials`，其它 handoff 直接 `blocked`（用于测量自主能力）。
- `irreversible:"deny"`（或 `"none"`，表示任务本不含不可逆步骤）：任何不可逆动作都不执行，以 `needs_confirmation` 结束。
- 结果：`{status, reason|code, finalUrl, tabId, verification:"model_done", metrics, tracePath}`。`done` 只是模型的完成声明，不是独立验证；P1a 不返回 `answer`（抽取回答属于 P2）。

`metrics`：`agentMs`（初始导航之后到终止，含等待与 handoff）、`navigationMs`、`jevMs`、`observeMs`、`execMs`、`settleMs`、`handoffWaitMs`、`jevRequests`、`jevInputTokens`、`jevUnknownUsage`、`steps`、`stale`、`handoffs`、`handoffKinds`、`decisions`（按风险级别计数）。

## 一个周期

1. 观察任务 tab 顶层文档（含 shadow DOM）：视口上下一屏内、最近的至多 160 个可交互元素，按页面位置排序；视口内可见文本至多 6000 字符；省略数进入 state。
2. 一次 Jev 请求，题目并行：
   - `operation`：CLICK / TYPE_TEXT / SELECT / PRESS_ENTER / SCROLL_DOWN / SCROLL_UP / WAIT / GO_BACK / DONE（只列有目标的操作；没有 BLOCKED 选项）。
   - `target_<OP>`：每个可用操作一道目标题，只列兼容元素；与操作题使用同一组规则。没有可访问名称的控件不提供（模型无从判断）；已由 input/field 填好的字段不再作为输入/选择/点击目标。
   - `bind_<n>`：每个未施加的 `inputs`/`files` 一道题，候选是**所有类型兼容**的字段（日期值只配日期/文本字段，数字只配数字/文本，select 需有同名选项，radio 名称需等于值，checkbox 需 true/false，自定义 option/radio/tab 的可访问名称需等于值（点击选择），文件只配文件输入，密码字段只接受 secret）+ `not_now`。不需要声明目标。
   - `field_<n>`：视口内、没有任何待施加 input 能填的字段（至多 12 个），问“目标文字是否规定了这个字段的值”：文本字段从目标文字的短语中选、select 从选项中选、checkbox/radio 只问是否勾选；否则 `keep`。
   - `text_value`：提供 TYPE_TEXT 时，从目标文字的短语中选要输入的原文；都不合适则选 `caller`（再走 text handoff）。
3. 策略（代码）：
   - 被接受的 bind（p ≥ 0.6、不冲突）和 field（p ≥ 0.7、非 keep）按页面顺序逐个执行；每个执行前重新观察，要求文档/URL 不变、该目标的 role/name/context/dialog 不变、仍可用；执行器再比较目标自身事实（值、状态与所在 form/行/对话框文字的哈希），不一致则 `not_sent`，绝不重放。
   - 批次在以下情况停止，剩余值留给下一次请求：目标身份变化、不可用、`not_sent`、后置条件不满足、跨文档导航、出现新的对话框/选项/菜单，或刚向 combobox 输入（通常需要先选建议项）。
   - 操作题问的是“这些值施加之后的下一步”。批次全部顺利、无冲突/低概率丢弃、目标仍在时，同一周期继续执行该操作（R3 或低于门槛的不执行，交给下一次请求）。
   - 否则按风险级别路由（见下）。
4. 执行后事件驱动等待：两帧或 50 ms（批内 16 ms）；向 combobox 输入后等可见选项出现且连续两次不变（最多 800 ms）；检测到跨文档导航则等到新文档再观察。同文档内的 URL 变化（history API）不使判断失效，目标自身的事实检查仍在。

state 还包含宿主记录的事实：`inputs`（每个值 applied/pending 及本页兼容字段数）、`inputSummary`（含本页没有字段的待填用途）、`unsubmittedTextFields`（输入后尚未提交的表单字段；对应提交按钮的目标描述会注明）、`recentActions`。

## 风险级别与门槛（路由默认值，非准确率）

| 级别 | 由代码按元素事实决定 | 执行条件 |
| --- | --- | --- |
| R0 | 滚动、等待、展开/收起（aria-expanded/haspopup/summary/tab）、同文档锚点、点击可编辑字段 | 取 argmax |
| R1 | 输入、选择、勾选类控件（option/checkbox/radio/switch）、bind | 操作概率 ≥ 0.4（目标可在多个合理项间分散） |
| R2 | 其它链接、按钮、表单提交、Enter、后退、DONE | min(操作, 目标) ≥ 0.5，且联合概率 ≥ 1.3 × 次优 |
| R3 | 支付字段表单的提交；最后一步的购买类词；提交/对话框/POST 表单中的删除、发送等强词；最后一步的 confirm/submit 类泛词 | 一律 `confirm` handoff；`deny` 模式终止 |

低于门槛时：若模型也给了滚动/等待 ≥ 0.15，先执行一次这个 R0 步骤；否则 `choose` handoff 列出前 6 个（操作×目标）选项。连续 3 次页面无变化或同一状态同一动作重复 3 次，也走 `choose`；第 3 次仍无进展则 `blocked`。有冲突或低概率未解决的 input 时，R2/R3 步骤交回调用方，避免带着缺失字段推进。

Choice 概率是候选间的相对偏好，不是正确率；以上数字来自开发期 trace，见校准报告（`node scripts/jev/calibration.mjs`），仍需独立验收数据修正。

## 安全边界

- `allowedOrigins` 必填。点击指向许可外 origin 的链接、或任务 tab 到达许可外 origin，都先 `confirm`（reason `allow_origin`），拒绝则 `blocked`。
- 秘密：只能经 bind 施加到兼容字段；观察中出现的秘密明文在进入 state 前替换；trace 写入前替换。
- 模型输出只是候选 ID，不会变成选择器、坐标、URL 或脚本；`browser_task` 不使用 eval/request/cookie 工具。
- 页面文字是不可信数据；Jev 判断不是权限边界，许可、确认与秘密都由代码强制。

## 已知限制（P1a）

- 只看顶层文档（含 shadow DOM）；iframe、新 tab/弹窗、下载、答案抽取属于 P2/P3。
- 合成 DOM 事件（`isTrusted=false`）；少数要求可信事件的控件不可用。
- 自定义下拉/日期控件没有专门执行器，依靠 CLICK 打开并点选。
- `field_` 与 `text_value` 只从目标文字中取原文短语；需要改写或生成的文本仍需调用方（text handoff 或预先给 inputs）。
- 外部网络不稳定时，首个 Jev 连接可能超时；TCP 连接超时（请求未发出）最多再试 2 次，每次单独占账本。

## 开发与测试

```sh
npm test                                   # 离线：tests/agent.test.mjs 等
node tests/e2e/task-complex.mjs            # 机械回放：真实循环+扩展+DOM，测试侧脚本化假 Jev（非模型证据）
node tests/e2e/task-complex.mjs --live     # 真实 Jev，complex-forms，只给 inputs（无声明目标）
node scripts/jev/task-run.mjs task.json [--approve]    # 任意 runner view
EVAL_ROOT=<eval 副本> EVAL_PORT_BASE=<端口基数> node scripts/jev/task-eval.mjs forma.travel_filter   # 使用 T33 评测站的私有副本
node scripts/jev/calibration.mjs [--sha=<prefix>]      # 从 trace 汇总门槛校准
```

以上都使用临时 profile 的 Chromium 与随机端口，不连接用户浏览器。机械回放中的应答器含夹具知识，只在测试中存在，只能证明管道；真实效果以独立验收者在冻结 SHA 上的运行为准。

## 开发期校准（P1a，开发者自测，非独立验收）

数据：`/tmp/jev-product/traces` 中 48 个开发期任务 trace（代码在多次迭代中变化，包括失败、网络超时与取消的运行；`node scripts/jev/calibration.mjs` 可复现），产品账本截至提交共 333 次 Jev 请求（含连接超时占号）。

| 头 | 被接受数 | 概率分布 | 正确性证据 |
| --- | --- | --- | --- |
| `bind_`（供值绑定，门槛 0.6） | 369 | 368 个 ≥0.9，1 个 0.8–0.9，0.6–0.8 无 | complex-forms 无声明目标的真实运行 6 次通过（atlas/standard ×3、birch、atlas/alternate、T33 harness 一次），服务器 oracle 均 32/32 + PDF |
| `field_`（目标文字规定的字段，门槛 0.7） | 47 | 全部 ≥0.9 | 人工逐条核对：Destination=Lisbon、Stay category=Design、Free cancellation 勾选、Where from?=Zurich、Where to?=London、Departure=November 20 2026，没有错填；complex-forms 中未规定的 radio 均回答 keep |

操作头（无绑定的周期，p = min(操作, 目标)）：

| 操作 | p | 执行 | R0 回退 | 交给调用方 | DONE |
| --- | --- | --- | --- | --- | --- |
| CLICK | ≥0.9 | 53 | 0 | 0 | – |
| CLICK | 0.8–0.9 | 40 | 0 | 0 | – |
| CLICK | 0.6–0.8 | 31 | 0 | 0 | – |
| CLICK | 0.4–0.6 | 12 | 1 | 10 | – |
| CLICK | <0.4 | 0 | 1 | 6 | – |
| WAIT | 0.4–≥0.9 | 19 | 0 | 2 | – |
| DONE | ≥0.9 | – | – | – | 18 |

观察到的错误执行与处置：
- p=0.50 的 SELECT 把已填好的 Visa category 改错。处置：已被 input/field 填好的字段不再作为 SELECT/TYPE_TEXT/CLICK 目标（结构性排除，不靠门槛）。
- Google Flights 一次在 0.57（操作 0.93 × 目标 0.57）点击 Search，早于把 Round trip 改为 One way，任务失败。R2 的 0.5 + 1.3 倍边际允许了这次错误；另一次同任务在同一代码族下通过（结果页 tfs 含 2026-11-20、ZRH→London，agentMs 9.8 s，12 次请求，未经 harness 判分）。该门槛需在独立运行数据上复核，不能据少量样本放宽。
- forma 旅行任务：只加目标规则时模型在“View Casa Flora”与“Find stays”间 0.54/0.45 分散，被 R2 门槛拦下；加入“未提交表单”宿主事实与目标题完整规则后连续 4 次通过（agentMs 约 2.1–2.8 s，4–5 次请求）。

结论：当前数字作为路由默认值保留；bind/field 门槛下没有观察到错误执行，操作头 0.4–0.6 区间有 1 次已知错误执行，需要独立验收数据再定。开发期外部网络（WSL 到 api.typesafe.ai、Wikipedia、Google）多次整段超时，Wikipedia 只完成过 1 次（3.8 s，3 次请求），相关失败不是模型判断造成，但同样计入账本。

### r2 修改（独立审查与代理后复测之后）

- 导航：点击指向其它文档的链接后，最多等 3 s 新文档再观察；提交表单或 Enter 后 150 ms 内继续监听 beforeunload；预期的导航未发生时，下一次 DONE 不被接受，先重新观察一次。r1 的 Wikipedia 假完成（建议项点击后 400 ms 才跳转，旧页面上接受了 DONE）由此修复。
- 门槛：Search/Submit/Apply/Find 类提交目标和 Enter 使用 0.6（其它 R2 仍为 0.5 + 1.3 倍边际）。自定义 combobox 的当前显示值作为 value 进入元素表（例如 `combobox "Round trip" = "Round trip"`），模型能比较当前值与目标。
- 页面 `confirm()`：browser_task 在自己的动作期间把原生确认框答“否”并报告文字（页面提交因此不发生），把该对话框作为确认点发 `confirm` handoff（reason `page_confirm_dialog`）；批准后对同一目标重做一次并接受该对话框；`deny`/`none` 模式以 `needs_confirmation` 结束。低层工具的对话框行为不变。
- Enter 按所属表单的提交控件判定风险（POST/支付/强词的最后一步为 R3）。
- secret 在绑定和执行时都按当前文档 origin 检查（不仅在 start 时）。
- 每个目标题超过 254 项时截断数写入 `state.omittedTargets`；最近的 alert/confirm/prompt 文字进入 `state.recentDialogs`。
- 请求字节上限为 120 KB（设计稿 48 KB）：绑定题较多的表单页约 30–37 KB、约 9k 输入 tokens，未超过 Jev 单请求限制；每次请求的字节数和 tokens 都写入 trace 的 `decision` 事件。

r2 复测（开发者自测，经 WSL 本地代理访问公网；此前的连接超时属于环境失败，不是模型判断）：Wikipedia 3/3 到达目标条目（3–4 次请求，agentMs 4.5–19.7 s，时间波动来自页面加载），T33 harness 判分 1/1 通过；Google Flights 3/3 到达结果页，tfs 解码为单程、2026-11-20、ZRH → London（11 次请求，agentMs 9.3–10.0 s，无 handoff）；harness 判分一次的页面读取检查中 one_way/origin/results 未通过而 URL 参数正确，已交给验收方核对检查条件。机械：`tests/e2e/task-confirm.mjs` 通过真实扩展证明确认框拒绝时 0 次提交、批准后 1 次、延迟导航被等待。
