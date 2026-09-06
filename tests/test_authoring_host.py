import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class AuthoringHostTests(unittest.TestCase):
    def test_fixed_workspace_tool_gateway(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="gate-author-host-") as directory:
            base = Path(directory)
            public = base / "public"
            public.mkdir()
            (public / "hello.txt").write_text("public source\n")
            private = base / "private-invariant.tla"
            private.write_text("PRIVATE_INVARIANT_CANARY")
            requests = [
                {"argv": ["/usr/bin/cat", "hello.txt"]},
                {"argv": ["/usr/bin/cat", str(private)]},
                {"argv": ["/usr/bin/true"], "runtime_mounts": [{"source": str(base), "destination": "/escape"}]},
                {"argv": ["/usr/bin/true"], "cwd": ".."},
            ]
            result = subprocess.run([sys.executable, str(root / "examples/authoring-host.py"), str(public)],
                input="".join(json.dumps(request) + "\n" for request in requests), text=True,
                capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            replies = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(len(replies), len(requests), result.stdout)
            self.assertEqual(replies[0]["result"]["stdout"], "public source\n")
            self.assertNotEqual(replies[1]["result"]["returncode"], 0)
            self.assertNotIn("PRIVATE_INVARIANT_CANARY", result.stdout + result.stderr)
            self.assertFalse(replies[2]["ok"])
            self.assertFalse(replies[3]["ok"])


if __name__ == "__main__":
    unittest.main()
