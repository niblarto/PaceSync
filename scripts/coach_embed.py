"""Pi-side Coach memory embeddings (backup for when the PC is off).

Reads {"texts": [str]} on stdin; prints {"model": "minilm", "vectors": [[...]]}
or {"error": str}. Uses all-MiniLM-L6-v2 through fastembed (ONNX, no
PyTorch); the model is cached under the app folder so it survives reboots.
"""

import json
import os
import sys

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def main() -> None:
    try:
        texts = [str(t) for t in json.loads(sys.stdin.read() or "{}").get("texts") or []]
        if not texts:
            raise ValueError("No texts")
        from fastembed import TextEmbedding

        model = TextEmbedding(MODEL, cache_dir=os.path.join(_APP_ROOT, ".fastembed"))
        vectors = [[round(float(x), 6) for x in v] for v in model.embed(texts)]
        print(json.dumps({"model": "minilm", "vectors": vectors}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)[:500]}))


if __name__ == "__main__":
    main()
