# browser-use

Chrome MV3 扩展与 MCP，附带 TypeSafe Jev 决策实验。

[真实实验结果与限制](docs/experiments/2026-09-21.zh-CN.md)：保留全部 180 个候选的页面选择，以及双字段确认保存，已通过原生 MCP 和独立结果核验。高层 `jev_run` 目前仅面向本地实验站，不是通用网站自动驾驶接口。

本地复刻与设计整理：[架构、JobShark 拆分关系、验证记录及 Jev 接入建议](docs/architecture.zh-CN.md)。

TypeSafe 全站阅读：[109 页阅读笔记与纠正](docs/typesafe/reading.zh-CN.md) · [逐页清单](docs/typesafe/pages.zh-CN.md)。

Jev 实验已接通：[运行说明与真实浏览器验证](docs/jev-runner.zh-CN.md)。

Source: `ShunL12324/browser-use@5a16c5dca40b457f6232cdbbba404783957eba20` (Git remote: `upstream`).

MCP-driven browser automation. Pair the Chrome extension with the `browser-use-mcp` bridge to drive Chrome from Claude Code (or any MCP client) with no Electron host.

```
Claude Code  <--stdio MCP-->  browser-use-mcp (Node)  <--ws://127.0.0.1:17329-->  Chrome Extension
```

The extension does the DOM work; the bridge translates MCP tool calls into a small WebSocket protocol. 18 tools, all `browser_*`-prefixed: snapshot, view, navigate, click, type, press_key, select, hover, upload_file, wait_for, scroll, tabs, network_log, eval_js, inspect, get_cookie, request, batch.

## License

[MIT](LICENSE). Maintained by ShunL12324 and contributors. The extension and bridge originate from [ShunL12324/browser-use](https://github.com/ShunL12324/browser-use); historical extraction from JobShark is documented above. Third-party dependencies retain their own licenses.

## Requirements

- **Chrome 124+** (for `chrome.dom.openOrClosedShadowRoot` — needed to pierce closed shadow DOM, e.g. Salesforce Lightning).
- Node 20+ to run the bridge.

## Setup

### 1. Build

```sh
cd /home/shun/projects/jev-browser-use
npm ci
npm run build
```

This produces:
- `packages/extension/dist/` — the unpacked extension
- `packages/bridge/dist/` — the Node MCP server

### 2. Load the extension

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select `packages/extension/dist/`
4. Pin the extension. The badge shows a red dot until the bridge connects.

### 3. Wire it to Claude Code

Add to your MCP config (`~/.claude.json` or run `claude mcp add`):

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/home/shun/projects/jev-browser-use/packages/bridge/dist/index.js"]
    }
  }
}
```

Restart Claude Code. `/mcp` should list `browser-use` as connected. The extension badge flips to green within ~5s.

### Trying it

> Navigate to example.com and snapshot the page.

Expect two tool calls — `browser_navigate` then `browser_snapshot` — with a list of interactable refs returned.

## How it works

- Bridge is the **WebSocket server**, extension is the **client**. The bridge binds `127.0.0.1:17329/mcp` only — unreachable from the network.
- Each MCP tool call → bridge sends a `command` frame → extension dispatches the matching tool → sends a `result` frame → bridge returns to MCP.
- The extension's universal automation surface (snapshot/refs, content-script tools, network capture) was ported from the [jobshark](https://github.com/ShunL12324/jobshark) project. The MCP bridge replaces what was previously an Electron host.

### Tool error model

Errors come back as MCP `isError: true` with a JSON body:

```json
{
  "code": "STALE_REF",
  "short_term": true,
  "message": "ref e42 no longer in DOM"
}
```

- `code` — stable identifier (STALE_REF, TIMEOUT, NO_ACTIVE_TAB, BRIDGE_DISCONNECT, EXTENSION_NOT_CONNECTED, …).
- `short_term` — `true` if the LLM should retry; `false` if it's a permanent fact to remember.

## Known limits (v0.1)

- **One Claude Code session at a time.** The bridge owns port 17329; a second invocation gets `EADDRINUSE` and exits. Multi-session support (a persistent broker daemon) is a v0.2 feature.
- **No image capture.** The `view` tool returns reading-order markdown only. Image capture is disabled in `packages/extension/src/lib/tools/view.ts` (one-line revert).
- **No Chrome Web Store distribution.** Manual `Load unpacked` only.
- **Closed shadow DOM** requires Chrome 124+. Older Chromes silently fail to pierce, so site-specific automation (Salesforce, etc.) will be flaky.

## Debugging

- **Bridge stderr** is visible in Claude Code's MCP server pane.
- **Extension service worker** logs: `chrome://extensions` → click the extension's **service worker** link → DevTools console.
- **Popup**: click the toolbar icon — shows current bridge state, URL, and the last 5 tool calls.

## Repo layout

```
packages/
  extension/    # Chrome MV3 extension (Vite + @crxjs/vite-plugin)
  bridge/       # Node MCP server, talks stdio ↔ WebSocket
```

Scripts:
- `npm test` — bridge regression tests and stdio/WebSocket integration smoke test (simulated extension)
- `npm run build` — both packages
- `npm run build:extension`
- `npm run build:bridge`
- `npm --workspace browser-use-extension run dev` — Vite HMR
- `npm --workspace browser-use-extension run pack` — zip the extension

隔离复杂页面实验与高层 `jev_run`：见 [J0 实验指南](docs/jev-lab.zh-CN.md)。

### Opt-in S1 protocol experiment

S1 adds document-bound observations, a static operation registry, target-bound parameter choices, and scoped UI assertions while retaining J0/J1. See [S1 protocol and isolated test instructions](docs/s1-protocol.zh-CN.md). Mechanical replay is not live Jev or generalization evidence.
