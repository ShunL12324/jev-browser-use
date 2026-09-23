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
   - `target_<OP>`：每个可用操作一道目标题，只列兼容元素；与操作题使用同一组规则。
   - `bind_<n>`：每个未施加的 `inputs`/`files` 一道题，候选是**所有类型兼容**的字段（日期值只配日期/文本字段，数字只配数字/文本，select 需有同名选项，radio 名称需等于值，checkbox 需 true/false，文件只配文件输入，密码字段只接受 secret）+ `not_now`。不需要声明目标。
   - `field_<n>`：视口内、没有任何待施加 input 能填的字段（至多 12 个），问“目标文字是否规定了这个字段的值”：文本字段从目标文字的短语中选、select 从选项中选、checkbox/radio 只问是否勾选；否则 `keep`。
   - `text_value`：提供 TYPE_TEXT 时，从目标文字的短语中选要输入的原文；都不合适则选 `caller`（再走 text handoff）。
3. 策略（代码）：
   - 被接受的 bind（p ≥ 0.6、不冲突）和 field（p ≥ 0.7、非 keep）按页面顺序逐个执行；每个执行前重新观察，要求文档/URL 不变、该目标的 role/name/context/dialog 不变、仍可用；执行器再比较目标自身事实（值、状态与所在 form/行/对话框文字的哈希），不一致则 `not_sent`，绝不重放。
   - 操作题问的是“这些值施加之后的下一步”。批次全部顺利、无冲突/低概率丢弃、目标仍在时，同一周期继续执行该操作（R3 或低于门槛的不执行，交给下一次请求）。
   - 否则按风险级别路由（见下）。
4. 执行后事件驱动等待：两帧或 50 ms（批内 16 ms；可编辑 combobox 最多 200 ms 等候选项）；检测到跨文档导航则等到新文档再观察。

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
EVAL_ROOT=<T33>/examples/eval node scripts/jev/task-eval.mjs forma.travel_filter
node scripts/jev/calibration.mjs [--sha=<prefix>]      # 从 trace 汇总门槛校准
```

以上都使用临时 profile 的 Chromium 与随机端口，不连接用户浏览器。机械回放中的应答器含夹具知识，只在测试中存在，只能证明管道；真实效果以独立验收者在冻结 SHA 上的运行为准。
