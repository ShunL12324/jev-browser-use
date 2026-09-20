# J0 独立复杂页面实验

J0 复用 T7 的 `prepare/decide/run` 判断策略；新增观察事件、预算、MCP 包装和测试站，不增加动作或改变题目。runner 搬到 `packages/bridge/src/jev/core.mjs` 随 bridge 打包，原 CLI 转引编译结果。

## 启动与关闭

在本任务 worktree 运行 `npm ci && npm run build`。三个进程分别负责 fixture、浏览器、MCP：

```sh
npm run lab
npm run browser:isolated
# 关闭刚才的隔离浏览器（不会关闭用户 Chrome）
npm run browser:isolated -- --stop
```

fixture 只监听 `127.0.0.1:17430`；浏览器自动复制编译扩展到临时目录，仅将默认 WS 17329 替换为 17429，使用临时 profile 和 headless Chromium。默认 Chromium 路径 `/home/shun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`，Playwright 模块 `/tmp/jev-browser-validation/node_modules/playwright/index.mjs`；可通过 `CHROMIUM_EXECUTABLE`、`PLAYWRIGHT_MODULE` 覆盖。浏览器脚本不会启动 bridge，退出时删除自己的 profile/扩展副本；控制 socket 默认为 `/tmp/jev-isolated-mcp-test/browser.sock`，可用 `JEV_BROWSER_CONTROL` 隔离机械测试。

原生 MCP 配置由 master 维护，唯一 server 指向此 worktree 的 `packages/bridge/dist/index.js`，环境包含：

- `BROWSER_USE_PORT=17429`
- `JEV_SOURCE_SHA=<冻结的完整git SHA>`
- `JEV_BUDGET_PATH=/tmp/jev-isolated-mcp-test/jev-budget.json`
- `JEV_TRACE_DIR=/tmp/jev-isolated-mcp-test/traces`
- `TYPESAFE_API_KEY` 从现有宿主环境继承，不写入配置示例或文件。

同一 MCP 暴露 18 个 `browser_*` 加 `jev_run`。不要再运行 `npm run jev` 启动第二个 bridge。同步 `jev_run` 单次最多 12 步、120 秒（另有排空时间），客户端请求超时需允许最多 300 秒；客户端取消不会抢占已发送的扩展动作，服务端持锁到该动作返回。桥命令 TIMEOUT/BRIDGE_DISCONNECT 意味着无法证明动作已结束，服务会锁闭后续工具并返回 `takeoverAllowed=false`；此时先关闭自己的隔离浏览器，再由 master 重启 MCP 和浏览器，保留 ledger，不自动重试。

## 创建、运行和独立验收

实验控制端创建 fresh run，例如：

```sh
curl -s http://127.0.0.1:17430/reset -H 'Content-Type: application/json' \
  -d '{"scenario":"A","density":8,"seed":"round1"}'
```

返回 `{runId, task}`；原样将 `task` 传给原生 `jev_run`。场景 A 密度为 8/64/180，180 触及资源上限时保留失败再测预设 120。密度计入 1 个搜索输入和其余记录 Open 按钮。场景 B 用 `scenario=B,density=8`；包含打开、编辑、两字段填写、确认、保存、关闭，共 7 个动作及末次完成观察。保存固定延迟 300ms，不引入随机竞态。模板提供可见标签、相近目录记录及 modal 外不可用的同名 Save。当前扩展不推导嵌套label名称，也不把inert自动视为disabled；本fixture显式设置aria-label和后台控件disabled。这只验证规范标签页面，并未修复或证明无标签页面能力。

每次 `POST /reset` 生成新 runId，不覆盖旧 run，seed 决定同一批记录和唯一目标。返回的 startUrl 始终打开这个 session，刷新保留服务端保存数据。fixture 进程重启会丢失所有 session，因此实验期间应保持它运行；轨迹和预算独立保存在文件中。

`jev_run` 返回自己的轨迹 runId，页面 fixture runId 在 startUrl 和页面头部，两者不同。返回的 `done` 只是原 T7 expectedText/模型判断，`verification` 永远为 `not_independently_verified`。Tester 在相同 task tab 通过低层原生 `browser_request` GET `/oracle/<fixture-runId>` 或独立 GET 接口核对 `passed/runId/targetId/openedId/saved`。Oracle 不嵌入页面、task 或 Jev state；初始、只填写未保存、保存错误记录均不通过。B 还要求保存后关闭编辑器。验收请求不得加入 Jev 轨迹或充当 Jev 动作。

停止后的 `handoff=true` 允许宿主在原 tab 通过低层工具继续，但不计 Jev 成功；没有 Jev resume API。宿主独立对照必须从新 reset 的同 seed 开始。

## 预算与证据

所有真实 `askJev` 调用（包括 standalone CLI/诊断）都在发送前通过共享 ledger 原子占号，最多 100 次，无自动重试；网络失败也消耗占号。`jev_run` 启动前检查剩余额度至少能容纳 maxSteps；每次发送仍检查上限。ledger 锁或JSON损坏时拒绝发送，不静默清零。不要删 ledger 或以不同路径运行付费实验。首轮分配 24 基线 / 48 单轴迭代 / 16 保留 seed / 12 诊断由 tester/master 调度；策略表示通过 mode 显式选择；默认 J0，J1 需传入 mode=J1。phase 是独立的实验阶段标签，不会隐式切换表示。

JSONL 包含源码SHA、配置、页面快照、问题和hash、候选/字节数、每次请求序号、模型答案概率及用量、proposed decision、实际工具开始/返回、终态时间与错误。API异常正文不入日志。这些快照只用于合成本地站。终态保留 tabId、请求数、已知 inputTokens、unknownUsageRequests、observe/execute/wait/API分段时间；独立验收耗时由tester补充。请求占号不等于已成功抵达服务端，未知费用不能当作零。

## 验证

```sh
npm test
node tests/e2e/jev-lab.mjs
```

离线测试检查预算、同bridge工具发现/转发、互斥与取消排空、错误保留证据、reset隔离和oracle负例。机械 E2E 在随机专用端口启动自己的临时 Chromium/真实扩展，通过 MCP→WS→扩展完成页面动作，不调用 Jev，不使用用户 Chrome。它不是原生MCP真实模型验收的替代。

开发时机械实测 A 的 enabled 数量为 8/64/180/120，对应初始payload约4597/24227/超过48000/43899 bytes；B 完整保存并通过oracle。以上均为设施证据，真实模型结果由独立tester记录。

## J1：无损紧凑候选表示

T105 的真实 J0 在 A180 因 48KB 请求上限停止。本轮仅压缩重复表示：元素字段 `ref/role/name/tag/value/disabled` 改为 `r/o/n/t/v/d`，模型 state 内附完整 `element_fields` 映射；click_target/type_target 的候选描述改为原 ref 字符串，题目追加查表说明。数组顺序、全部候选（包括干扰项）、none、页面全文、值、目标及历史均保留。缺失字段、null、false、空字符串不互换。

执行侧 `prepared.elements` 与循环检测 fingerprint 仍使用原始对象；动作、目标校验、阈值、48KB、步数、完成和 API 策略不改，fixture 不改。表示信息可逆不代表模型表现相同，必须通过独立真实实验核验。

`jev_run` 保持默认 `mode=J0`。运行 J1 时将 `/reset` 返回 task 加上 `"mode":"J1","phase":"J1"`；只改 phase 不会切换模式。CLI task JSON 同样接受 mode。trace 开始、prepared、terminal 和 ledger 各请求均记录 mode。J0 的模型 payload 不包含额外 mode 字段，冻结黄金测试与 T105 保持等价。

离线检查 `npm test` 包括逐字段解码、候选顺序/none、frame ref、缺失/null/false/空串、给定同一答案的执行决定、原始指纹，以及254/255候选边界。机械容量预检运行 `node tests/e2e/jev-lab.mjs --compact`；它在随机隔离端口用真实扩展检查 round1/round2/holdout 的首步与点击目标后的第二步，写入 `/tmp/jev-lab-preflight-*`，不触碰17429，不发Jev请求。

批准的真实矩阵：J1 round1 A8/A64/A120/A180各最多4次加B最多12次；round2 A180最多4次加B最多12次；冻结后holdout同样最多16次，总计最多60次，加已有15次不超过75。所有请求继续使用现有100次ledger；失败不退号。遇误完成或错记录保存先保留轨迹并暂停配置，不临时放宽阈值。
