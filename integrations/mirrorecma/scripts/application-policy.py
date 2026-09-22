#!/usr/bin/env python3
"""Build the base operator policy for the fixed application Gate runner."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from mirrorgate.control_policy import example_policy_document


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("submission_root", type=Path)
    parser.add_argument("node_shim_root", type=Path)
    parser.add_argument("node_runtime_root", type=Path)
    parser.add_argument("policy_id")
    parser.add_argument("adapter_id")
    parser.add_argument("target_profile")
    parser.add_argument("state_computer_contract_version")
    args = parser.parse_args()
    document = example_policy_document(
        submission_root=args.submission_root,
        node_shim_root=args.node_shim_root,
        node_runtime_root=args.node_runtime_root,
        policy_id=args.policy_id,
        adapter_id=args.adapter_id,
        target_profile=args.target_profile,
        state_computer_contract_version=args.state_computer_contract_version,
    )
    with args.output.open("x", encoding="utf-8") as destination:
        json.dump(document, destination, ensure_ascii=False, separators=(",", ":"))
        destination.write("\n")


if __name__ == "__main__":
    main()
