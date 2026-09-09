#!/usr/bin/env python3
"""Test-only synthetic author on the real controller and isolation backend.

This bypasses runtime/audit admission explicitly; it is NOT Codex acceptance.
Never installed or imported by the production launcher.
"""
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'supervisor'), str(ROOT / 'tests')]
from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate.preparation import ControlBackend
from mirrorgate.control_server import serve_stream, serve_unix
from test_hosting_controller import CAPS, FakeHost, Profile

if __name__ == '__main__':
    mode, source, host_mode = sys.argv[1:4]
    document = example_policy_document(submission_root=source, node_shim_root=ROOT)
    backend = ControlBackend(PolicyCatalog.from_document(document))
    if not backend._probe_backend()[0]:
        raise RuntimeError('Real Bubblewrap required for native hosting lifecycle')
    backend.hosting_capability_reports = lambda: CAPS
    backend.admit_agent = lambda state, profile, task, limits=None: Profile().admit(task, limits)
    FakeHost.mode = host_mode
    try:
        with patch('mirrorgate.orchestration.AgentHost', FakeHost):
            if mode == 'stdio':
                serve_stream(sys.stdin.buffer, sys.stdout.buffer, backend,
                             principal_uid=os.getuid(), connection_mode='stdio')
            elif mode == 'unix':
                serve_unix(sys.argv[4], backend)
            else:
                raise ValueError('Unsupported fixture transport')
    finally:
        result = backend.close()
        if not result.complete:
            raise RuntimeError('Fixture backend cleanup incomplete')
