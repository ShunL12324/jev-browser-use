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

已启用 `activate`（原生 link/button）、`replace_text`（原生 textarea 或 text/search/email/url/tel/password input）、页面上下滚动、目标滚入视口及短暂 wait。操作的 domain、映射、重放分类和后置检查在 registry 中声明；新能力需要补观察/registry/页面执行器，不在循环中新增动作分支。S1 激活使用同步 DOM `click()`，输入使用原生 value setter 加 input/change；不是可信硬件事件，不保证所有控件兼容。

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

这里的目标绑定只限制参数域，不指定动作顺序。未匹配字段不会获得 replace_text 候选；自由文本生成、select 选项、文件上传等不在 S1 范围。字段同名且无可用上下文时能力 unknown；名称、角色与 dialog 上下文唯一才允许候选。参数题仍可能作出语义错误选择，UI 断言与独立 oracle 负责检出。

## 观察成本与真实性

content-script 初始化生成随机 document token，不能用 URL 代替；同 URL 重载和重新注入会换身份。原 snapshot 增量返回每 frame 的身份、matched/returned/truncated/failed；frame 失败和合并裁剪进入汇总 coverage。view 仍 top-only，300 字符段落裁剪现在设置 truncated。

S1 在一条 top-frame 消息内同步采集 snapshot、view、事实、断言。事实包括原生 type/value/readonly/disabled、label-for/aria-labelledby、inert、活动模态 dialog 归属和 shadow 边界。不是完整可访问性树；只对采集器范围声明 `complete_in_scope`。child frames、虚拟化内容、关系图缺口显式保留。断言逐 scope 只读定位，不执行页面脚本，不进入候选路线；跨 iframe/shadow 的完整性无法证明时 unknown。

动作消息同时携带 document token、URL、ref 和观察时的事实。页面执行器重新检查身份、名字、值、能力、inert/dialog 及中心点命中，在同步段检查后派发。遮挡、readonly、错误控件不执行。跨域链接不枚举，并在执行前检查 href。仍不能保证业务处理器不会自行跳转，也不能辨认同 DOM 节点被复用但所有已采事实完全相同的业务替换。不能宣称业务事务原子性。

## 完成和恢复

断言结构为 `{id, scope, subject, read, predicate, expected, freshness}`；scope 固定 top，root/subject 支持 exact role/name 或宿主只读 selector。scope 必须唯一。read 支持 text/value/exists；equals/contains 只用于字符串，absent 只用于 exists。缺 scope、重复 subject、属性缺失或不完整的否定证据产生 unknown。截断字符串可以证明正向 contains，不能证明 equals。

所有断言 AND 成立才 `verified`，含义是声明的 UI 条件，不等于业务持久化。`after_last_returned_operation` 由核心绑定最近返回动作 ID，重新观察发生在该动作返回之后；仅证明时间先后，不证明因果。无断言时模型只能 `reported_done`。旧 expectedText 仅输出 `legacy_text_match`，不能升级为 verified。

`not_sent` 的 PAGE_CHANGED/STALE_REF 可在 `maxRecoveries` 与独立请求预算内重新观察和决策。导航后的只读采集允许短暂有限重采；动作不因此重放。执行响应丢失为 unknown，服务 gate 保持 poisoned，要求隔离浏览器/bridge 人工接续。确定已返回动作之后的新一轮模型选择仍受基于文档、事实、滚动位置与操作的重复检测控制。wait/无效滚动仍耗步数。

首片不做多 frame 任务、定向容器滚动、虚拟列表探索、完整关系图、select、自由文本生成、canvas/drag 或开放互联网。浏览器工具本身仍保留，不把这些能力自动授予 S1 registry。

## 证据级别

离线测试证明 schema、参数绑定、预算、超时不重放和确定性验证合同。机械浏览器测试证明三类夹具共用核心与真实扩展执行，以及重载、readonly、模态和截断负例。冻结 SHA 后同三类真实 Jev + 独立 oracle 成功，才证明该批样本上的闭环决策效果；不能据此宣称任意网站泛化。真实验收由独立执行者报告，仓库测试脚本本身不产生该结论。
