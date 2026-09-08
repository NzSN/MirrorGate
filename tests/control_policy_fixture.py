"""Write a runnable shared control-v1 policy for Python/Node/C++ tests."""

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate.control_policy import (example_policy_document,
                                       example_rust_policy_document,
                                       example_shared_policy_document)


def write_policy(path: Path, submission_root: Path, *, runtime: str = "node",
                 artifact_entry: str | None = None,
                 adapter_entry: str | None = None, faulty: bool = False,
                 policy_id: str | None = None,
                 adapter_id: str | None = None,
                 target_profile: str | None = None,
                 state_computer_contract_version: str | None = None) -> Path:
    if adapter_entry is not None:
        if artifact_entry is not None:
            raise ValueError("use artifact_entry or adapter_entry, not both")
        artifact_entry = adapter_entry
    if runtime == "node":
        document = example_policy_document(
            submission_root=submission_root,
            node_shim_root=ROOT,
            node_runtime_root=os.environ.get("MIRRORGATE_NODE_RUNTIME_ROOT"),
            adapter_entry=artifact_entry or "adapter.mjs",
            policy_id=policy_id or "test.node",
            adapter_id=adapter_id or "mirrorgate/node-v1",
            target_profile=target_profile or "node-v1",
            state_computer_contract_version=(state_computer_contract_version
                                             or "mirrors.state-computer/v1"),
        )
    elif runtime == "rust":
        document = example_rust_policy_document(
            submission_root=submission_root, artifact_entry=artifact_entry or "worker",
            faulty=faulty, policy_id=policy_id,
            adapter_id=adapter_id or "mirrorgate/rust-v1",
            target_profile=target_profile or "rust-v1",
            state_computer_contract_version=(state_computer_contract_version
                                             or "mirrors.state-computer/v1"))
    elif runtime == "shared":
        document = example_shared_policy_document(
            submission_root=submission_root, node_shim_root=ROOT,
            node_runtime_root=os.environ.get("MIRRORGATE_NODE_RUNTIME_ROOT"),
            include_faulty_rust=faulty)
    else:
        raise ValueError("runtime must be node or rust")
    path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("submission_root", type=Path)
    parser.add_argument("--runtime", choices=("node", "rust", "shared"), default="node")
    parser.add_argument("--artifact-entry", "--adapter-entry", dest="artifact_entry")
    parser.add_argument("--faulty", action="store_true")
    parser.add_argument("--policy-id")
    parser.add_argument("--adapter-id")
    parser.add_argument("--target-profile")
    parser.add_argument("--state-computer-contract-version")
    args = parser.parse_args()
    write_policy(args.output, args.submission_root, runtime=args.runtime,
                 artifact_entry=args.artifact_entry, faulty=args.faulty,
                 policy_id=args.policy_id, adapter_id=args.adapter_id,
                 target_profile=args.target_profile,
                 state_computer_contract_version=args.state_computer_contract_version)
    print(args.output)
