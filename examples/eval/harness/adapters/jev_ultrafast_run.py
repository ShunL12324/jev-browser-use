"""Runs one jev-ultrafast Agent and prints a JSON summary line.

UNVERIFIED: browser-harness (its Chrome/CDP layer) is not installed in
/tmp/jev-ultrafast, and TYPE_TEXT needs TEXT_MODEL_API_KEY. Paid: every
decision is a TypeSafe request. Only the validator runs this, on a ledger.
"""

import argparse
import json
import time

from jev_ultrafast import Agent

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--goal", required=True)
args = parser.parse_args()

started = time.perf_counter()
agent = Agent(args.url, args.goal)
try:
    for _ in agent.run():
        pass
finally:
    state = agent.snapshot()
    try:
        text = agent.browser.evaluate("document.body.innerText")
    except Exception:
        text = None
    agent.close()

usage = [d.get("usage", {}) for d in state.get("decisions", [])]
print(json.dumps({
    "status": state["status"],
    "agentMs": state["elapsed_ms"],
    "wallMs": round((time.perf_counter() - started) * 1000),
    "jevRequests": len(state.get("decisions", [])),
    "jevInputTokens": sum(u.get("input_tokens", 0) for u in usage),
    "jevUnknownUsage": sum(1 for u in usage if "input_tokens" not in u),
    "llmRequests": len(state.get("text_calls", [])),
    "finalUrl": state["page"]["url"],
    "pageText": text,
}))
