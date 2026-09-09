#!/usr/bin/env python3
"""Test-only deterministic author on the production controller/isolation backend.

Runtime admission is replaced explicitly, so this is NOT live Codex evidence.
All source writes still execute via the real restricted authoring tool callback.
This fixture is never packaged as an application launcher or production fallback.
"""
import argparse
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "supervisor"))
from mirrorgate.agent_runtime import HostResult
from mirrorgate.control_policy import PolicyCatalog
from mirrorgate.control_protocol_v2 import HOST_LIMITS
from mirrorgate.control_server import serve_stream
from mirrorgate.preparation import ControlBackend


class SyntheticAuthor:
    def __init__(self, admission, **callbacks):
        self.admission = admission
        self.__dict__.update(callbacks)

    def run(self):
        task = self.admission.task
        # The fixture's approved task chooses which independent real SUT to write.
        faulty = "faulty" in task["instructions"]
        canary = os.environ["GATE_WORKFLOW_PRIVATE_PATH"]
        counter = (ROOT / "runtimes/node/examples/counter.mjs").read_text()
        adapter = (ROOT / "runtimes/node/examples/faulty-counter.mjs").read_text() if faulty else counter
        guard = "import {existsSync} from 'node:fs';\nif(existsSync(" + json.dumps(canary) + ") || process.env.GATE_WORKFLOW_SECRET) throw new Error('execution private access');\n"
        build = "import os, shutil\nassert not os.path.exists(" + repr(canary) + ")\nassert 'GATE_WORKFLOW_SECRET' not in os.environ\nshutil.copytree('/source', '/output', dirs_exist_ok=True)\n"
        files = {"adapter.mjs": guard + adapter, "counter.mjs": counter, "build.py": build}
        code = ("import os, pathlib\nassert not os.path.exists(" + repr(canary) + ")\n"
                "assert 'GATE_WORKFLOW_SECRET' not in os.environ\n"
                "assert list(pathlib.Path('.').iterdir()) == [], 'fresh author workspace required'\n"
                "files = " + repr(files) + "\n"
                "for name, text in files.items(): pathlib.Path(name).write_text(text)\n")
        result = self.execute("python", ["-c", code])
        if result["returncode"] != 0:
            return HostResult(1, "failed", True, ())
        self.submit()
        try:
            self.execute("python", ["-c", "raise RuntimeError('tools must be sealed')"])
        except Exception:
            pass
        else:
            return HostResult(1, "failed", False, ("post-submit-tool",))
        return HostResult(0, "exited", True, ())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["control"])
    parser.add_argument("--stdio", action="store_true", required=True)
    parser.add_argument("--policy-file", required=True)
    args = parser.parse_args()
    backend = ControlBackend(PolicyCatalog.from_document(json.loads(Path(args.policy_file).read_text())))
    if not backend._probe_backend()[0]:
        raise RuntimeError("real Bubblewrap is required")
    backend.hosting_capability_reports = lambda: [
        {"id": "hosting.fresh-agent-v1", "available": True, "enforcedScope": "session", "limits": {}},
        {"id": "hosting.codex-v1", "available": True, "enforcedScope": "session", "limits": {}},
    ]
    backend.admit_agent = lambda state, profile, task, limits=None: SimpleNamespace(
        task=task, limits=dict(HOST_LIMITS, **(limits or {})))
    try:
        with patch("mirrorgate.orchestration.AgentHost", SyntheticAuthor):
            serve_stream(sys.stdin.buffer, sys.stdout.buffer, backend,
                         principal_uid=os.getuid(), connection_mode="stdio")
    finally:
        if not backend.close().complete:
            raise RuntimeError("synthetic workflow fixture cleanup incomplete")


if __name__ == "__main__":
    main()
