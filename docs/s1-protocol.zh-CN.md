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

## 第二轮真实失败与选单观察补全

冻结 `b64cfc4` 的第二轮主例 atlas/standard 完成 Contact 七项并进入 Preferences、打开角色选单后仍 `UNCERTAIN`：目标 Frontend Engineer 为 0.46，已展开触发按钮为 0.37，另一个 radio 为 0.11。9 个已返回动作、11 次请求、61764 输入 tokens，总失败至 oracle 时间 7.048 秒（模型等待 5.452 秒）；未提交，服务器仍 0/32、无上传。一次异步表单有效性变化触发 `STALE_REF`，通过原有重新观察/决策恢复，没有重放已发送动作。按预定规则停止其它两例，r1 三失败保留；中央累计 22/240，剩 218。该单次前进到第二阶段不证明完整成功或策略普遍改善。

第三轮 `form_preferences_v3` 补原来漏掉的真实 DOM 证据：`expanded` / `selected` 对合法 ARIA 布尔值输出 true/false，缺失或非法为 null；`hasPopup` 保留合法 ARIA token，缺失/非法为 null。option 的 `listbox` 只来自实际 DOM 祖先，包含局部 ref、名称、可见性、截断标志和 `source: dom_ancestor`；listbox 名称也进入语义容器上下文。同名选单不会因 ref 不同就自动变成可区分的同名选项。

`controls` 只解析显式 `aria-controls`：缺失为 absent、所有 ID 唯一且可解析为 known、缺失目标/重复 ID/超过采集界限为 unknown。不使用 DOM 邻近位置推测触发器对应哪个选单。编译器只在 complex profile 展示这些事实，目标关系名称截断会标记 `nameTruncated`。模型准则说明：请求选项已经可用时，优先选项而非重复激活已展开触发器。所有原候选及 0.6 阈值仍保留，模型仍负责判定是否符合目标；展开、已选状态、关联或祖先归属变化参与执行前事实比较。

Choice 的归一化分布表示候选间**相对偏好**，不是单个动作的正确率或安全概率。两个都合理的动作会竞争概率；把相近候选的概率相加不能证明任何一个动作适宜。当前 0.6 是沿用的选择门槛，而非经过校准的安全置信度。如果本轮补全真实事实后仍出现同类分散，应停止继续叠加提示，另行研究“先选候选，再独立判断该已绑定动作是否受证据支持”的最小合同：显式拒绝/未知、同一次观察和参数绑定、单独判断阈值及负例、额外每动作至多一次模型请求并计入同一中央预算。该合同尚未实现或授权实测，不能在报告中当作现有能力；也不能用第二个分数替代实际执行前置条件和服务器 oracle。

## 第四轮：form_batch_v1 决策合同（opt-in）

r3 最后一步（trace `064a9181`）在 set_checked Hybrid 0.48 与 replace_text 薪资 0.30 之间停下，两者都是正确的下一步。单一 Choice 要求所有候选竞争同一分布并过 0.6，多个同时有效的待填字段必然分摊概率；继续加提示不能消除这种结构问题。第四轮改变合同，不改提示方向。

启用：task 同时设置 `profile: "complex_forms"` 与 `decision: "form_batch"`（可选 `minSuitability`，默认 0.8）。默认 `decision: "single"` 保持上文全部行为与请求内容；`form_batch` 在非 complex profile 下被 schema 拒绝。

### 每次观察一次请求

依据 Jev 接口事实（见 [阅读笔记](typesafe/reading.zh-CN.md) §1–3）：一次请求可携带多个共享 state 的独立问题；Choice 是候选间相对排名，Noul 是命题为真的概率；官方建议 Choice 配合独立 fits/exists 判断，并由代码定义最终政策（speculative fan-out：预问所有分支，只消费适用的分支）。每轮请求包含：

1. `b1…bn`：每个**当前页有合格目标且仍待填**的 task 值/文件各一道 Choice。候选为 registry domain 中包含该值的目标句柄 + `not_now`。不同字段各自一道题，概率不再互相分摊。已附文件的文件目标不再提供（模型不能选择重复上传）。
2. `next`：对**非输入**操作（activate、scroll_into_view、scroll、wait）的 Choice + none。
3. `f1…fm`：每个非输入操作一道 Noul，询问“假设当前没有可施加的输入，现在执行它是否是有证据支持、尊重前置条件与待填必要输入的有用步骤”。
4. `goal_met`：与旧合同相同。

参数题不再单独发送：绑定题同时给出值与目标。文件仍只以宿主授权的 fileId 进入题目与执行，字节和路径从不进入 task/模型。

### 宿主政策（代码）

- 绑定：`choice !== not_now` 且概率 ≥ `minProbability` 才接受；同一目标被多个值选中时全部丢弃（`binding_conflict`）。
- 有接受的绑定时，本轮只执行绑定，按 observation.objects 顺序逐个执行，不消费 `next`。每个执行前在**最新观察**上重新解析：documentId/URL 与全部对象身份（ref、role、name、context、dialog 的集合，与顺序无关）必须与判断时一致；操作仍合格；值仍在该目标 domain 中（如 option 仍存在且启用）。然后用最新事实生成执行请求，页面执行器照旧比较完整事实。任何身份变化、不合格、值不再在 domain、`not_sent` 或后置条件 unmet 都停止本批剩余绑定，重新观察并发下一次请求。已发送动作绝不重放。
- 可见但中心点不可达的目标（屏外/遮挡）在 registry 中仅有 scroll_into_view；batch 另外以 `reveal` 标记提供其底层操作。执行时宿主先派发 scroll_into_view（计一步），重新观察，要求身份不变且操作已合格后才执行，否则停止。遮挡不会因滚动消失，此时停在 `not_eligible`。
- 无接受的绑定时消费 `next`：top 概率 ≥ `minProbability` 则执行（basis `choice`）；否则当 top 的 fits ≥ `minSuitability` 且 top 同时是 fits 最大者时执行（basis `suitability`）；否则 `UNCERTAIN`。`none` → `NO_CANDIDATE`。
- 步数、请求、token、时长上限、有限恢复、重复状态检测、poison gate、仅由断言得出 verified 均不变。`goal_met` 只在无断言时产生 `reported_done`。

### 语义与限制（诚实说明）

- Choice 概率是所列选项间的**相对偏好**，不是准确率或安全概率；0.6 与 0.8 是沿用/设定的路由门槛，未经校准。fits Noul 与 Choice 来自同一模型、同一证据，是第二个判断而非独立验证。真正的保障是执行前事实比对、断言与服务器 oracle。
- **值到字段的映射仍由 task 声明的目标（role/name/可选 context 的精确匹配）完成。** 因此大多数绑定题只有“一个目标 + not_now”，Jev 实际判断的是“现在施加还是不施加”，不是在多个字段之间为值选择字段。trace 的 `bindTargetCounts` 记录每题目标数，报告应给出单目标题所占比例。无目标声明的值（让 Jev 在全部兼容字段中绑定）不在本轮范围。
- 自定义弹出选择（如 ARIA listbox）仍走 `next`：打开触发器、选择选项，各需一次请求。
- 页面动态变化（异步加载、依赖字段出现、新增行）会停止批次，新出现的值只在下一次观察中提问；这会多花请求，但不在旧判断上执行新对象。
- 负载保持 48 KB 字节上限、每题 ≤254 个选项，超出直接 `RESOURCE_LIMIT`，不做 top-k 截断。fits 数量随页面可激活元素增加。

### Trace 事件

`batch_decision`：payloadBytes、各类题数（bind/fits/next/goal_met）、本请求 inputTokens、`bindTargetCounts`、accepted（valueId、目标、概率、目标数）、drops（`not_now` / `low_probability` / `binding_conflict`）、next（候选、概率、fits、basis）、goalMet。`batch_stopped`：reason（`identity_changed` / `not_eligible` / `not_in_domain` / `not_sent` / `postcondition_unmet` / `step_limit` / `not_revealable`）与剩余值。`reveal`：宿主滚动。`parameter_binding` 的 method 为 `batch`。`batch_round`：每轮 modelMs、observationMs（含批内重新观察）、executionMs 与执行数。服务照旧记录 api_started/api_finished 与总 timings。

### 证据级别

- 离线（`tests/jev-s1-batch.test.mjs`）：opt-in、题目构成、阈值/not_now/冲突丢弃、next 双门槛、身份变化/文档变化/新增行/陈旧 ref/option 消失/屏外 reveal 的停止或执行、无假完成。
- 机械（`node tests/e2e/complex-s1-batch.mjs`，需先启动 17431 夹具）：真实 `runS1` batch 循环经 stdio MCP → WebSocket → 扩展 → DOM，在 atlas/standard 上 verified，服务器 oracle 32/32 + PDF hash 正确，16 次（伪）请求。其应答器在运行时读取每次编译出的题目：接受所提供的全部绑定，导航按夹具名称脚本选择。**这是管道测试，不是模型证据**；脚本只存在于测试中，核心没有夹具知识。其请求数只说明理想应答下的下限，不代表真实 Jev 的请求数、速度或成功率。
- 真实 Jev 效果只能由独立验收者在冻结 SHA 上运行得出。

另修正：view 中 checkbox/radio 行不再显示提交值 `= "on"`，改为 `(checked)` / `(unchecked)`；机械测试断言该渲染。
