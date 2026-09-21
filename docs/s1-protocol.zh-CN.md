# S1：有限的通用浏览器协议

S1 在既有 Chrome 扩展、WebSocket、stdio MCP 和 Jev API 上添加一套 opt-in 协议。J0/J1 和 `jev_run` 保留。新增网站只替换声明式 task 与测试 HTML；核心不读取站点 oracle，也不包含文章、设置、项目的流程分支。

## 启动与边界

```sh
npm ci
npm run build
node scripts/jev/s1-fixtures.mjs
# 在已加载该构建扩展的独立 Chromium profile 对应的 bridge 中启用：
JEV_ENABLE_S1=1 node packages/bridge/dist/index.js
```

启用后注册 `jev_run_s1` 和测试适配器 `browser_s1`；默认不注册。入口只接受 `http://127.0.0.1:17430` / `http://localhost:17430`，协议核心使用 `allowedOrigins`，没有端口/域名分支。不能连接用户日常浏览器做实验。机械测试自行创建并清理临时 Chromium profile、扩展副本和随机 WebSocket 端口：

```sh
npm test
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chromium node tests/e2e/jev-s1.mjs
```

机械脚本没有 live 模式。它用确定性决策回放验证实际 stdio MCP → WebSocket → 扩展 → DOM 链路，不能替代真实 Jev 决策验收。

测试服务器 `GET /new/article`、`/new/settings`、`/new/workspace` 返回 `{id, task}`；将 task 原样传给 `jev_run_s1`。测试侧单独读取 `GET /oracle/{id}`。oracle 状态不进入 task、观察或问题。文章 oracle 检查目标文档请求，设置 oracle 检查服务器接收的两字段值，分栏 oracle 检查打开的项目；UI 断言与 oracle 分开报告。

真实 S1 发送默认使用 `/tmp/jev-generalization/s1-review/live-budget.json`，中央账本硬限 30 次尝试。`JEV_S1_BUDGET_PATH`、`JEV_S1_TRACE_DIR` 可指定独立实验路径，`JEV_SOURCE_SHA` 标注冻结候选。每 run 在浏览器动作前验证 `maxRequests <= 账本剩余`，每次发送前原子占号，失败也占额度，无自动重发。不得通过更换路径重置已授权预算。旧账本仍默认 100；两种 limit 互不兼容，避免误用。key 仅由运行环境提供，不写入 trace。日志包含 task/页面输入，应视为本地实验数据。

## 数据与函数边界

`packages/bridge/src/jev/s1.mjs` 提供普通函数：

- `validateS1Task`：strict schema，只接受可序列化声明数据。拒绝流程步骤、脚本、定制 verifier 与未知字段。
- `adaptObservation`：生成 v0 observation，保留 tab/frame/document/ref、事实、能力、稀疏关系、coverage 和来源证据。
- `enumerate` / `compile`：静态 registry 产生 `{target, operation}` 句柄；全量候选超过 254 或请求超过 48 KB 直接 `RESOURCE_LIMIT`，不做静默 top-k。
- `bindIntent` / `executionRequest`：参数绑定观察与已选目标。`replace_text` 的第二次 Jev 请求只包含该字段的值域。
- `verify`：解释范围化 UI 断言；`runS1` 统一观察、决策、执行、后验与有限恢复，不分站点或动作名。

已启用 `activate`（原生 link/button 和显式 button/option/tab/menuitem/combobox 语义控件）、`replace_text`（原生 textarea 或 text/search/email/url/tel/password/number/date/datetime-local/month/week/time input）、`select_option`（单选原生 select）、`set_checked`（原生 checkbox/radio）、`upload_file`（宿主授权文件）、页面上下滚动、目标滚入视口及短暂 wait。操作的 domain、映射、重放分类和后置检查在 registry 中声明；新能力需要补观察/registry/页面执行器，不在循环中新增动作分支。S1 激活使用同步 DOM `click()`，输入使用原生 value setter 加 input/change；不是可信硬件事件，不保证所有控件兼容。

任务值需要明确用途与目标标签：

```json
{
  "city": {
    "text": "Hangzhou",
    "purpose": "New city",
    "target": {"role": "textbox", "name": "City"}
  }
}
```

这里的目标绑定只限制参数域，不指定动作顺序。未匹配字段不会获得参数化候选；已满足的文本、选择和勾选值不再枚举。自由文本生成不在范围。字段同名且无可用上下文时能力 unknown；名称、角色、dialog 和语义容器上下文共同消歧。重复名称的参数必须指定唯一 `target.context`，不能仅靠同名字段的某个共享祖先；context 来自 fieldset legend 或显式 group/radiogroup/row 的可访问名称，不接受站点选择器。参数题仍可能作出语义错误选择，UI 断言与独立 oracle 负责检出。

## 观察成本与真实性

content-script 初始化生成随机 document token，不能用 URL 代替；同 URL 重载和重新注入会换身份。原 snapshot 增量返回每 frame 的身份、matched/returned/truncated/failed；frame 失败和合并裁剪进入汇总 coverage。view 仍 top-only，300 字符段落裁剪现在设置 truncated。

S1 在一条 top-frame 消息内同步采集 snapshot、view、事实、断言。事实包括原生 type/value/readonly/disabled、label-for/aria-labelledby、inert、活动模态 dialog 归属和 shadow 边界。不是完整可访问性树；只对采集器范围声明 `complete_in_scope`。child frames、虚拟化内容、关系图缺口显式保留。断言逐 scope 只读定位，不执行页面脚本，不进入候选路线；跨 iframe/shadow 的完整性无法证明时 unknown。

动作消息同时携带 document token、URL、ref 和观察时的事实。页面执行器重新检查身份、名字、值、能力、inert/dialog 及中心点命中，在同步段检查后派发。遮挡、readonly、错误控件不执行。跨域链接不枚举，并在执行前检查 href。仍不能保证业务处理器不会自行跳转，也不能辨认同 DOM 节点被复用但所有已采事实完全相同的业务替换。不能宣称业务事务原子性。

## 完成和恢复

断言结构为 `{id, scope, subject, read, predicate, expected, freshness}`；scope 固定 top，root/subject 支持 exact role/name 或宿主只读 selector。scope 必须唯一。read 支持 text/value/exists；equals/contains 只用于字符串，absent 只用于 exists。缺 scope、重复 subject、属性缺失或不完整的否定证据产生 unknown。截断字符串可以证明正向 contains，不能证明 equals。

所有断言 AND 成立才 `verified`，含义是声明的 UI 条件，不等于业务持久化。`after_last_returned_operation` 由核心绑定最近返回动作 ID，重新观察发生在该动作返回之后；仅证明时间先后，不证明因果。无断言时模型只能 `reported_done`。旧 expectedText 仅输出 `legacy_text_match`，不能升级为 verified。

`not_sent` 的 PAGE_CHANGED/STALE_REF 可在 `maxRecoveries` 与独立请求预算内重新观察和决策。导航后的只读采集允许短暂有限重采；动作不因此重放。执行响应丢失为 unknown，服务 gate 保持 poisoned，要求隔离浏览器/bridge 人工接续。确定已返回动作之后的新一轮模型选择仍受基于文档、事实、滚动位置与操作的重复检测控制。wait/无效滚动仍耗步数。

当前不做多 frame 任务、定向容器滚动、虚拟列表探索、完整关系图、多选 select、自由文本生成、canvas/drag 或开放互联网。浏览器工具本身仍保留，不把这些能力自动授予 S1 registry。

## 证据级别

离线测试证明 schema、参数绑定、预算、超时不重放和确定性验证合同。机械浏览器测试证明三类夹具共用核心与真实扩展执行，以及重载、readonly、模态和截断负例。冻结 SHA 后同三类真实 Jev + 独立 oracle 成功，才证明该批样本上的闭环决策效果；不能据此宣称任意网站泛化。真实验收由独立执行者报告，仓库测试脚本本身不产生该结论。

## 复杂表单 opt-in

宿主同时设置 `JEV_ENABLE_S1=1 JEV_ENABLE_COMPLEX_FORMS=1`，task 增加 `profile: "complex_forms"`。入口额外允许隔离 localhost/127.0.0.1:17431。该 profile 固定使用 `/tmp/jev-complex-forms/live-budget.json`，硬限 **240 次实际发送尝试**，错误也占号，不能用旧路径变量切换账本；中央锁与持久化占号复用既有预算实现。不得删除/更名该账本续费。未显式启用的 task 仍受旧 12 步、30 请求、120 秒、100000 输入 token 上限。

复杂 task 可配置 `maxSteps <= 160`、`maxRequests <= 240`、`timeoutMs <= 1800000`、`maxInputTokens <= 2000000`；默认值仍兼容旧 S1，使用者必须声明实验需要的上限。run 启动前要求剩余账本覆盖 `maxRequests`。默认置信阈值仍为 0.6，没有为复杂实验降低。总时长到达后停止新动作；已发送动作先等到明确返回，传输不确定仍 poison gate。

`select_option` 的 task 值为 option 的原生 value，只绑定当前唯一且启用的 option；`set_checked` 的值为字符串 `"true"`/`"false"`，radio 仅允许设 true。受控输入使用原生 setter 和 input/change，checkbox/radio 使用原生 click；这些是 DOM 合成事件，不保证要求 isTrusted 的站点可用。自定义选单仍由模型选择 activate 操作，核心没有网站流程。

仅 complex_forms 对**模型已经选中的操作**且参数域只有一个授权值时直接绑定，省去第二次无歧义请求；多个值仍发独立参数题。此规则不替模型选择字段，也不自动填写剩余字段。旧 S1 的两阶段请求数不变。模型 state 只保留一次精简观察；操作选项引用对象 ID 和名称；参数题只包含选中目标及其值域，不重复整页和其它输入。

文件输入示例：

```json
{"files":{"resume":{"fileId":"synthetic-resume","purpose":"Supplied synthetic PDF","target":{"role":"file","name":"Résumé PDF"}}}}
```

宿主设置 `JEV_S1_FILES_MANIFEST=/absolute/host-manifest.json`，文件内容为 `{ "synthetic-resume": { "name": "resume.pdf", "mimeType": "application/pdf", "data": "BASE64_BYTES", "sha256": "64_lowercase_hex" } }`。这属于明确宿主授权；task/model 只能给 fileId，不能给路径或字节。启动前及每次执行前检查 ID、大小（最多 10 MB）、规范 base64 与 SHA-256。字节不进入模型请求和执行 trace（仅记录名称、类型、hash）。S1 通过已有 `actSetFiles` 的 File/DataTransfer/change 链路上传，且在同一同步段先检查 document/ref/全部事实；文件实际持久化仍须服务器 oracle 核验。

观察增加 option、checked、file 元信息、可点击中心点与容器上下文。可见但中心点不可达的控件只提供滚入视口，不直接派发。所有操作派发前重新比较完整事实，选项禁用、行上下文、勾选状态、文件状态变化都会拒绝旧请求。宿主元数据授权不等于页面业务成功。

返回 `timings` 使用单调时钟：`totalMs` 从 runner 接收开始到最终 UI 验证；`serviceTotalMs` 额外包含服务校验、预算和 trace；`modelMs` 包含失败模型等待，`navigationMs` 包含建 tab 和导航，`observationMs` / `executionMs` 为浏览器对应调用，`browserMs` 为这些调用总和。settle/retry delay 和本地计算在总时长内。独立 benchmark 必须从服务调用前计时到服务器 oracle 返回，补充 `oracleMs` 和整体端到端时长；构建、启动单独列出，不能从步骤计时推算总时长。

这些能力的原始缺口在 b992949：textTypes 不含 date/number；registry 无 select/check/file；重复字段仅按 dialog 判断；每个操作 criterion 重复完整对象且参数题重发全页。仓库离线及扩展机械测试证明协议与真实派发，不代表真实 Jev 已通过复杂夹具；真实结果由独立验收报告给出。

本地机械复现（先按夹具文档启动 17431）：

```sh
npm run build
npm test
node tests/e2e/jev-s1.mjs
node tests/e2e/complex-s1.mjs
```

后两者使用临时 profile、随机 bridge 端口、扩展副本及合成文件 manifest，关闭后清理浏览器目录，输出 `/tmp/*-mechanical-*/` 证据路径。`complex-s1.mjs` 的固定顺序只存在于测试回放，不能作为真实模型决策、速度提升或布局泛化证据；它不调用 Jev、不改中央付费账本，只用 atlas/standard 主样本检查控件可用性。

## 第一轮真实失败与第二轮待验证假设

独立验收对冻结 `15df8ae`（夹具 `4a7ff73`）运行 Jev 1.13.0：atlas/standard、birch/standard、atlas/alternate 三个新 reset 全部 `UNCERTAIN`，完整提交成功 **0/3**。选中动作概率分别为 0.59、0.56、0.43，均未达到未改动的 0.6 阈值；动作数 0/4/4。总计 11 次请求、50100 输入 tokens、无 API 错误，固定账本剩余 229/240。服务器三次均未提交、0/32、无文件；后两次 DOM 中四个值正确不能当作服务器保存或完整成功。

三次从 run 到独立 oracle 的失败耗时为 1.763 / 2.937 / 3.316 秒；这是失败终止时间，不能作为完整填写速度。原 b992949 在第一阶段缺少 Country select 能力，零付费基线不能完成，因此不能计算完整成功的前后加速比。原始失败不得覆盖或从结果统计排除；完整报告及 traces 位于本地 `/tmp/jev-complex-forms/round1-report.md`、`live-audit.json` 和 `live-traces/`。

末次概率的主要替代项分别是 Continue 0.16、Continue 0.23、滚至 Continue 0.33；后两轮 wait 为 0.12/0.13，另一个可填字段 Postal code 仅 0.03。因此“很多等价字段分摊概率”尚不足以解释全部失败；更具体的假设是缺少表单必要字段及推进/等待之间的选择准则。

第二轮仅对 complex_forms 的操作题使用 `form_preferences_v2`：优先处理当前可用且有授权输入的未满足字段，存在其它可填字段时不必等待一个异步字段；原生必要输入仍无效时不要把提前推进当作进展；确有前置依赖时仍可打开自定义控件、滚动或等待。无依赖且同等有用的输入按观察对象顺序打破平局。模型仍看到并选择**全部原候选**，包括提交、滚动和 wait；宿主不筛成单项、不代选目标、不自动填写、不叠加类别概率、不重问探测。

观察增加只读 `required`、`valid`、`buttonType`、`formInvalidCount`，后者统计同原生 form 中参与约束验证且 invalid 的控件数（不是业务必填字段总数）。读取 `validity.valid`，不调用会派发 invalid 事件的 `checkValidity()`。这些事实无法证明自定义/服务器校验通过。complex 操作 criterion 增加 `valueIds` 指向已有授权域；没有新增 API 问题或预算。旧 S1 操作题说明和默认 0.6 保持不变。离线/机械验证只能证明事实采集、候选保留及无副作用；概率和实际完成率改善必须由下一冻结版本真实试验检验，不能提前宣称成功。
