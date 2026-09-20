# Jev browser-use 第一轮实验

这个版本在现有扩展和 MCP 上增加 Node 决策循环。扩展源码、18 个 MCP 工具及其协议未改；bridge 修复了退出时没有关闭已连接扩展、可能占住端口的问题。

## 已跑通的链路

```text
任务 JSON → Node runner → Jev（同一次请求 4–6 个问题）
                  ↓
              检查返回值
                  ↓
          stdio MCP → WebSocket → 真实扩展 → 网页
                  ↑                         ↓
                  └────── view / snapshot ─┘
```

测试任务是在本地网页将 Display name 填成 River，再点击保存。当前版本支持点击、填写普通 input/textarea、上下滚动、短暂等待及停止；输入文本来自任务提供的 values。没有自由文本生成器、拖动、select/upload 动作规划或复杂网页的通用规划能力。

每次观察后，同时询问动作、点击目标、完成情况、是否受阻；有输入框与候选值时再问输入目标和输入值。程序只消费获选动作的参数。每步固定同一个新建 tab，执行前重新检查 URL 和元素。Jev key 只由 Node 从环境读取，不传给扩展或 bridge。

## 直接试一下

仓库根目录已提供构建脚本：

```sh
npm ci
npm run build
```

Windows Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，目录为：

```text
\\wsl.localhost\Ubuntu-24.04\home\shun\projects\jev-browser-use\packages\extension\dist
```

已有同目录扩展则点“重新加载”。如果 Chrome 不接受 WSL 路径，把整个 `dist` 复制到 Windows 本地目录再加载；以后构建更新也需重新复制。首次加载只需加载一次。

WSL 终端一，启动本地网页：

```sh
cd /home/shun/projects/jev-browser-use
npm run demo
```

WSL 终端二，运行实验：

```sh
cd /home/shun/projects/jev-browser-use
npm run jev -- --task examples/jev/task.json
```

runner 会启动自己的 bridge、创建一个后台标签页、执行任务并退出。最终标签页保留，便于查看结果。`--check` 可先确认扩展连接并列出标签页；它不会请求 Jev：

```sh
npm run jev -- --check
```

`--dry-run` 会创建并打开任务页、读取页面及请求 Jev，但不执行模型选出的动作：

```sh
npm run jev -- --task examples/jev/task.json --dry-run
```

同一端口只支持一个 bridge。运行 runner 时，其他 MCP 客户端不能同时占用 17329。连接等待约 15 秒；WSL 与 Windows 的 localhost 转发需要正常工作。若 Windows 无法访问 `http://localhost:17330/`，先解决本机转发，当前实现不会自动把 bridge 暴露到网络。我们已验证 Linux Chromium 链路，未代替用户操作 Windows Chrome 来验证这段跨系统连接。

`TYPESAFE_API_KEY` 必须在启动 runner 的 shell 中可用；若刚设置持久变量，打开新终端即可。默认固定 `jev-1.13.0`，可用 `TYPESAFE_DEFAULT_MODEL` 覆盖；默认官方 HTTPS endpoint。运行输出包含选择、ref、模型、累计输入 token 和结束状态，不默认打印页面全文、输入值或 key。

## 如何写任务

见 [通用测试任务](../examples/jev/task.json)。字段：

| 字段 | 含义 |
| --- | --- |
| goal | 这次要完成的具体目标 |
| startUrl | 在新标签页打开的 HTTP(S) 起点 |
| values | 允许填写的命名文本候选，最多 254 项；none 是保留项 |
| expectedText | 可选：页面观察文本包含此字符串就满足任务的完成契约 |
| maxSteps | 最多决策轮次，默认 12；上限 50 |
| timeoutMs | 整个循环时限，默认 120000 毫秒 |
| minProbability | 所消费选项的概率下限，默认 0.6；不是 confidence 字段 |
| doneProbability | 未提供 expectedText 时，完成 Noul 的阈值，默认 0.9 |
| maxInputTokens | 返回用量累计阈值，默认 100000；达到限制后不再执行动作 |

`expectedText` 应写成能证明目标完成的具体结果，而不是页面开头就有的标题。它是代码的字符串检查，不是语义证明；不提供时才用 Jev 的完成判断。最终日志标明 `expected_text` 或 `model_judgment`，避免混淆两种依据。

第一版遇到低概率、无候选、元素变化或 API 错误就停止，不会擅自改用文本匹配、坐标或重放动作。重复观察下同一动作最多执行两次。页面截断、超过 254 个可用元素、请求超过保守的 48 KB UTF-8 预算时明确报错，不默默丢候选。它没有使用官方 tokenizer，48 KB 是此实验的额外保守限制。

单次 API 超时 20 秒，不自动重试。token 阈值在 API 返回后核算，可能超过一个请求的用量，不是精确计费硬上限。Ctrl+C 会取消等待并阻止后续动作，但不能撤销已经发给扩展的动作。扩展页面上的旧 Stop 按钮仍只上报事件，当前 runner 不接收它，停止请用终端 Ctrl+C。

当前限制为同一 origin，链接跳到其他 origin 或打开新标签页会停止。页面脚本仍可能在一次点击中自行导航；这里的 URL 检查不是浏览器沙箱。固定 ref 的二次检查也不能完全消除检查和执行之间的 DOM 变化。

## 验证记录（2026-09-20）

- `npm run build`：bridge 与扩展完整构建通过。
- `npm test`：10/10，通过非法候选、低概率、截断、origin 变化、乐观完成判断、过期元素、取消、token 预算、重复动作和端口释放检查；包含真实 stdio MCP 与模拟扩展的循环集成测试。
- 真实 Chromium 149.0.7827.55 + 实际 MV3 扩展 + MCP，确定性测试判断器：填写、点击、页面结果校验通过。
- 同一真实浏览器链路换成官方 Jev 1.13.0：3 次请求，每次 6 题，共 3784 输入 tokens；选择填写 → 点击保存 → 根据页面的成功文本结束。测试框架另外读取实际 DOM，确认输入框和保存结果均为 River。

真实 Jev 初测揭示了终止条件问题：完成页面上，笼统的完成 Noul 仍只有约 0.57–0.70，0.9 阈值没有满足。最终版本保留阈值，改为明确的 expectedText 完成契约。最终成功运行的完成 Noul 是 0.59，**不能把本次成功说成模型可靠判断了完成**；它正确选出了两个动作，代码核验了完成结果。

这些是一个简单英文、本地表单的结果，不代表跨网站或复杂多步任务的成功率。Windows 日常 Chrome 尚待加载后联调。测试用浏览器采用临时 profile、临时端口，退出删除 profile，没有读取日常浏览器登录状态。

## 可重复的真实浏览器测试（可选）

[测试脚本](../tests/e2e/jev-browser.mjs) 用 Playwright 启动浏览器并校验 DOM；runner 的页面操作仍全部经 MCP 和扩展，未通过 Playwright 代替填写或点击。Playwright 不是运行 runner 的依赖，也不会在普通 `npm test` 中启动浏览器或消费 API。

本次测试的 Playwright 1.63.0 安装在临时目录。需要复现时可单独安装，不改项目依赖：

```sh
npm install --prefix /tmp/jev-browser-validation --no-audit --no-fund playwright@1.63.0
/tmp/jev-browser-validation/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/jev-browser-validation/node_modules/playwright/index.mjs \
  node tests/e2e/jev-browser.mjs
```

追加 `--live` 会读取环境 key 并真实请求 Jev；`CHROMIUM_EXECUTABLE` 可指定已有 Chromium。测试会复制编译产物到临时目录，仅替换其中 bridge 端口以隔离测试连接；原扩展构建目录不变。`--live --debug` 只用于这个合成测试页，会打印其 state 和 answers，不适合含真实隐私数据的任务。
