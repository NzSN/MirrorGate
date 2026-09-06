#!/usr/bin/env python3
"""Trusted agent-host example: bind workspace once, expose only bounded tool requests."""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "supervisor"))
from mirrorgate import AdmissionError, GateSession, ToolRequest, TrustedConfig
from mirrorgate.protocol import ProtocolError, parse_frame


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace", help="trusted host configuration; never supplied by a tool request")
    args = parser.parse_args()
    with GateSession(TrustedConfig("authoring", args.workspace)) as session:
        while line := sys.stdin.buffer.readline(65537):
            if len(line) > 65536 or not line.endswith(b"\n"):
                print(json.dumps({"ok": False, "error": "tool frame exceeds limit or lacks LF"}), flush=True)
                return 2
            try:
                request = ToolRequest.from_dict(parse_frame(line))
                result = asdict(session.run(request))
                # Text diagnostics only. A tool can explicitly request base64 for binary data.
                result["stdout"] = result["stdout"].decode("utf-8", errors="replace")
                result["stderr"] = result["stderr"].decode("utf-8", errors="replace")
                print(json.dumps({"ok": True, "result": result}, ensure_ascii=True), flush=True)
            except (AdmissionError, ProtocolError, ValueError) as error:
                print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
