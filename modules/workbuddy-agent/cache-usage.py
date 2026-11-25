#!/usr/bin/env python3
"""Read only model usage from an exact WorkBuddy project; never print chat text."""
import argparse
import json
import pathlib


def usage_rows(project_dir, after_ms):
    for transcript in sorted(pathlib.Path(project_dir).glob("*.jsonl")):
        with transcript.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                timestamp = row.get("timestamp")
                if not isinstance(timestamp, (int, float)) or timestamp < after_ms:
                    continue
                provider = row.get("providerData") or {}
                raw = provider.get("rawUsage") or {}
                total = raw.get("prompt_tokens")
                if not isinstance(total, (int, float)) or total <= 0:
                    continue
                cached = raw.get("prompt_cache_hit_tokens")
                if cached is None:
                    cached = (raw.get("prompt_tokens_details") or {}).get("cached_tokens")
                if cached is None:
                    cached = raw.get("cache_read_input_tokens")
                yield {
                    "timestamp": timestamp,
                    "model": provider.get("model"),
                    "inputTokens": total,
                    "cachedTokens": cached,
                    "cacheHitPercent": round(cached / total * 100, 2) if cached is not None else None,
                }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_directory")
    parser.add_argument("--after-ms", type=float, default=0)
    args = parser.parse_args()
    print(json.dumps(sorted(usage_rows(args.project_directory, args.after_ms), key=lambda row: row["timestamp"])))
