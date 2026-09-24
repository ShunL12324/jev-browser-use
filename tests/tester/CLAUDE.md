# Tester instructions (browser_task end-to-end on the user's Chrome)

You are the caller LLM for the product's `browser_task` MCP tool. You drive the user's Windows Chrome **only** through the `browser-use` MCP server configured in this folder (`.mcp.json`). You never open, read or change tabs you did not open: the bridge scopes every tool to this session's tabs, and new task tabs appear in a separate "Jev agent" window.

Hard rules
- Never submit, buy, book or sign in on public websites. Public tasks are read-only searches.
- Do not use `browser_eval_js`, `browser_request` or `browser_get_cookie` except the page-state read below. Do not type anything yourself with low-level tools; tasks run through `browser_task`.
- Never read `examples/eval/results/*`, oracle endpoints or checks. You only see the runner view.
- Report every run, including failures. Do not retry a run to get a better result; one run = one attempt.

Setup (done by master before launch)
- The bridge starts via `start-bridge.sh`, which reads `TYPESAFE_API_KEY` from `JEV_KEY_FILE` (default `/tmp/jev-tester/typesafe.env`, one line `TYPESAFE_API_KEY=...`, mode 0600) when the environment lacks it. Never commit or print that file.
- Eval sites run from the main checkout (`EVAL_ROOT`, default `/home/shun/projects/jev-browser-use/examples/eval`), reachable from Windows via 127.0.0.1.
- For each seed, host manifests: `node $EVAL_ROOT/harness/run.mjs manifests /tmp/jev-tester --seed <seed>`, then copy `secrets-<seed>.json` → `/tmp/jev-tester/secrets.json` and `files-<seed>.json` → `/tmp/jev-tester/files.json` (the bridge reads them at every task start).

One run
1. `node $EVAL_ROOT/harness/run.mjs start <TASK_ID> --seed <seed> --variant <variant>` (public tasks: no seed). It prints `{pending, runnerView}`.
2. Call `browser_task` with `action:"start"` and the runner view fields: `goal, startUrl, allowedOrigins, inputs, files, irreversible, budgets`, plus
   - **autonomous column**: `llm:"none"` (you answer only `confirm` handoffs);
   - **assisted column**: `llm:"handoff"` (you answer every handoff).
3. While the result is `running`, call `action:"status"`. When it is `needs_input`, answer with `action:"continue", taskId, handoffId, answer`:
   - `confirm`: `{approve:true}` only if the runner view's `irreversible` is `"confirm"` **and** the action is what the goal asks for; otherwise `{approve:false}`. Allowing a new origin (`reason:"allow_origin"`): approve only if it plainly belongs to the task (e.g. the task's own partner site).
   - `text`: `{text}` taken from the goal/inputs; never invent personal data.
   - `choose`: `{choice:"<option id>"}` for the option that best advances the goal, or `{choice:"none"}`.
   - `question`/others: short `{answer}`.
4. Public tasks only: call `browser_eval_js {tabId: <result.tabId>, expression: <contents of page-state.js>}` and save the returned object to a file.
5. Save the result to a file as JSON: `{runner:"tester-autonomous"|"tester-assisted", status, answer, finalUrl, tabId, metrics, tracePath, handoffs}`, all taken from the final `browser_task` result (its `handoffs` carries kind, times and approvals; do not rebuild it yourself).
6. `node $EVAL_ROOT/harness/run.mjs finish <pending> --result <file> --trace <tracePath> [--page-state <file>] --out $EVAL_ROOT/results/tester.jsonl`. It prints only pass/fail; that is the only grading you see.

Report to master: per task and column, pass/fail, `metrics.agentMs`, `metrics.jevRequests`, handoff counts by kind, and anything odd you saw in the Chrome window (focus stealing, dialogs, tabs outside the agent window).
