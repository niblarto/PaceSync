"""On-Pi Coach chat for the hosted providers (Claude, Gemini) — the local
Ollama model is reached over HTTP on the AI DJ service PC instead
(POST /coach/chat).

Reads {"system": str, "messages": [{"role", "content"}], "model": str,
"effort"?: str, "web"?: bool} on stdin; prints one JSON line: {"reply": str}
(plus "sources" in web mode) or {"error": str}. "web" answers with Gemini +
Google Search (the Coach's web search button).
"""

import json
import os
import sys

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)
# In development ai_dj lives in the sibling AI_DJ repo; on the Pi it's
# deployed to the app root.
if not os.path.isdir(os.path.join(_APP_ROOT, "ai_dj")):
    _dev = os.path.join(os.path.dirname(_APP_ROOT), "AI_DJ")
    if os.path.isdir(os.path.join(_dev, "ai_dj")) and _dev not in sys.path:
        sys.path.insert(0, _dev)

from ai_dj.llm import DEFAULT_CLAUDE_EFFORT, chat_text, chat_text_gemini_web  # noqa: E402


def main() -> None:
    try:
        body = json.loads(sys.stdin.read() or "{}")
        messages = [m for m in body.get("messages") or [] if m.get("role") in ("user", "assistant") and m.get("content")]
        if not messages:
            raise ValueError("No messages")
        if body.get("web"):
            print(json.dumps(chat_text_gemini_web(body.get("system") or "", messages, model=body["model"], timeout=240)))
            return
        reply = chat_text(
            body.get("system") or "",
            messages,
            model=body["model"],
            effort=body.get("effort") or DEFAULT_CLAUDE_EFFORT,
            timeout=240,
        )
        print(json.dumps({"reply": reply}))
    except Exception as e:  # noqa: BLE001 — every failure goes back to the app as JSON
        print(json.dumps({"error": str(e)[:500]}))


if __name__ == "__main__":
    main()
