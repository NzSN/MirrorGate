"""Real backend tests. MIRRORGATE_REQUIRE_SANDBOX=1 makes absence a failure."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from mirrorgate import AdmissionError, GateSession, Limits, RuntimeMount, ToolRequest, TrustedConfig
from mirrorgate.artifacts import remove_snapshot


class IsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as source:
            try:
                with GateSession(TrustedConfig("execution", source)) as gate:
                    result = gate.run(ToolRequest(("/usr/bin/true",)))
                if result.returncode != 0:
                    raise AdmissionError(result.stderr.decode(errors="replace"))
            except (AdmissionError, OSError) as exc:
                if os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1":
                    raise RuntimeError(f"required sandbox unavailable: {exc}") from exc
                raise unittest.SkipTest(f"real bubblewrap backend unavailable: {exc}")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "submission"
        self.source.mkdir()
        (self.source / "public.txt").write_text("public")

    def tearDown(self):
        remove_snapshot(self.root)
        self.temp.cleanup()

    def run_python(self, code, *, profile="execution", limits=None, output=None):
        with GateSession(TrustedConfig(profile, self.source, output=output, limits=limits or Limits())) as gate:
            return gate.run(ToolRequest(("/usr/bin/python3", "-c", code)))

    def test_private_files_environment_processes_and_inherited_fds_denied(self):
        private = self.root / "private-oracle"
        private.write_text("invariant-secret-59628")
        code = f"""
import json,os
result={{}}
for name,path in {{'private':{str(private)!r},'hostroot':'/proc/{os.getpid()}/root','home':{str(Path.home())!r},'hostenv':'/proc/{os.getpid()}/environ','socket':'/run/docker.sock'}}.items():
    try:
        open(path,'rb').read(1)
        result[name]=False
    except OSError:
        result[name]=True
result['secret']=os.environ.get('MIRRORGATE_TEST_SECRET') is None
result['fds']=all(int(x)<=2 or not os.path.exists('/proc/self/fd/'+x) for x in os.listdir('/proc/self/fd'))
status=open('/proc/self/status').read()
result['no_new_privs']='NoNewPrivs:\\t1' in status
result['no_caps']='CapEff:\\t0000000000000000' in status
result['pid_namespace']=os.getpid()==1
print(json.dumps(result))
"""
        previous = os.environ.get("MIRRORGATE_TEST_SECRET")
        os.environ["MIRRORGATE_TEST_SECRET"] = "invariant-secret-59628"
        try:
            for profile in ("authoring", "build", "execution"):
                with self.subTest(profile=profile):
                    result = self.run_python(code, profile=profile)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue(all(json.loads(result.stdout).values()), result.stdout)
                    self.assertNotIn(b"invariant-secret-59628", result.stdout + result.stderr)
        finally:
            if previous is None:
                del os.environ["MIRRORGATE_TEST_SECRET"]
            else:
                os.environ["MIRRORGATE_TEST_SECRET"] = previous

    def test_host_network_and_nested_namespaces_denied(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            code = f"""
import socket,subprocess
s=socket.socket();s.settimeout(.2)
try:
 s.connect(('127.0.0.1',{port}));raise SystemExit('host accessible')
except OSError:pass
result=subprocess.run(['/usr/bin/unshare','--user','true'],capture_output=True)
assert result.returncode != 0
print('denied')
"""
            for profile in ("authoring", "build", "execution"):
                with self.subTest(profile=profile):
                    result = self.run_python(code, profile=profile)
                    self.assertEqual(result.stdout, b"denied\n", result.stderr)

    def test_profile_write_permissions(self):
        result = self.run_python("from pathlib import Path;Path('created').write_text('yes')", profile="authoring")
        self.assertEqual(result.returncode, 0, result.stderr)

        self.assertEqual((self.source / "created").read_text(), "yes")
        output = self.root / "output"
        output.mkdir()
        result = self.run_python("from pathlib import Path;Path('/output/worker').write_text('built')\ntry:Path('/source/public.txt').write_text('bad');raise AssertionError('writable source')\nexcept OSError:pass", profile="build", output=output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((output / "worker").read_text(), "built")
        result = self.run_python("from pathlib import Path\nfor p in ['/artifact/public.txt','/outside','/usr/evil']:\n try:Path(p).write_text('bad');raise AssertionError(p)\n except OSError:pass\nPath('/scratch/state').write_text('ok');Path('/tmp/temp').write_text('ok')")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_runtime_output_alias_attempt_is_rejected_before_launch(self):
        runtime = self.root / "approved-runtime"
        runtime.mkdir()
        config = TrustedConfig("build", self.source, output=runtime, runtime_mounts=(RuntimeMount("/usr", "/usr"), RuntimeMount(runtime, "/runtime/tools")))
        with self.assertRaisesRegex(AdmissionError, "runtime and build output roots must not overlap"):
            with GateSession(config) as gate:
                gate.run(ToolRequest(("/usr/bin/python3", "-c", "from pathlib import Path;Path('/output/injected').write_text('changed runtime')")))
        self.assertEqual(list(runtime.iterdir()), [])

    def test_execution_freezes_live_source(self):
        with GateSession(TrustedConfig("execution", self.source)) as gate:
            (self.source / "public.txt").write_text("changed after submission")
            result = gate.run(ToolRequest(("/usr/bin/cat", "public.txt")))
            self.assertEqual(result.stdout, b"public")

    def test_symlink_cannot_escape_authoring_namespace(self):
        private = self.root / "private"
        private.write_text("oracle")
        code = f"import os;os.symlink({str(private)!r},'link')\ntry:open('link').read();raise AssertionError('escape')\nexcept OSError:print('denied')"
        result = self.run_python(code, profile="authoring")
        self.assertEqual(result.stdout, b"denied\n", result.stderr)
        with self.assertRaises(AdmissionError):
            GateSession(TrustedConfig("execution", self.source))

    def test_output_caps(self):
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream):
                limits = Limits(stdout_bytes=1024, stderr_bytes=1024)
                result = self.run_python(f"import os;os.write({1 if stream == 'stdout' else 2},b'x'*100000)", limits=limits)
                self.assertEqual(result.reason, stream + "_limit")
                self.assertLessEqual(len(getattr(result, stream)), 1024)

    def test_wall_deadline_and_explicit_cancellation(self):
        result = self.run_python("import time;time.sleep(60)", limits=Limits(wall_seconds=.25))
        self.assertEqual(result.reason, "wall_timeout")
        self.assertLess(result.duration_seconds, 3)
        with GateSession(TrustedConfig("execution", self.source)) as gate:
            process = gate.start(ToolRequest(("/usr/bin/python3", "-c", "import time;print('ready',flush=True);time.sleep(60)")))
            self.assertEqual(process.read_stdout(timeout=5), b"ready\n")
            process.cancel()
            process.wait(timeout=3)
            self.assertEqual(process.reason, "cancelled")

    def test_eof_cleanup(self):
        with GateSession(TrustedConfig("execution", self.source, limits=Limits(eof_grace_seconds=.1))) as gate:
            process = gate.start(ToolRequest(("/usr/bin/python3", "-c", "import time;print('ready',flush=True);time.sleep(60)")))
            self.assertEqual(process.read_stdout(timeout=5), b"ready\n")
            process.close_stdin()
            process.wait(timeout=3)
            self.assertEqual(process.reason, "stdin_eof")

    def test_children_that_start_new_sessions_die_on_main_exit(self):
        # A surviving descendant would retain stdout and keep monitor.wait open.
        code = "import os,time\nif os.fork()==0:\n os.setsid();time.sleep(60)\nelse:\n print('parent exiting',flush=True);os._exit(0)"
        result = self.run_python(code, limits=Limits(wall_seconds=2))
        self.assertEqual(result.reason, "exited", result.stderr)
        self.assertEqual(result.stdout, b"parent exiting\n")
        self.assertLess(result.duration_seconds, 1.5)

    def test_hanging_descendants_die_on_deadline(self):
        code = "import os,time\nif os.fork()==0:os.setsid()\ntime.sleep(60)"
        result = self.run_python(code, limits=Limits(wall_seconds=.25))
        self.assertEqual(result.reason, "wall_timeout", result.stderr)
        self.assertLess(result.duration_seconds, 3)

    def test_cpu_fd_and_tmpfs_bounds(self):
        result = self.run_python("while True:pass", limits=Limits(cpu_seconds=1, wall_seconds=5))
        self.assertEqual(result.reason, "failed", result.stderr)
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(result.duration_seconds, 4)
        code = "import os,resource\nassert resource.getrlimit(resource.RLIMIT_NOFILE)==(32,32)\nassert resource.getrlimit(resource.RLIMIT_NPROC)==(4096,4096)\nfds=[]\ntry:\n for _ in range(40):fds.append(os.open('/dev/null',os.O_RDONLY))\n raise AssertionError('unbounded descriptors')\nexcept OSError:print('bounded')"
        result = self.run_python(code, limits=Limits(open_files=32))
        self.assertEqual(result.stdout, b"bounded\n", result.stderr)
        code = "import errno\nfor path in ['/tmp/file','/scratch/file']:\n try:\n  with open(path,'wb') as f:f.write(b'x'*(2*1024*1024))\n  raise AssertionError('unbounded storage')\n except OSError as e:assert e.errno==errno.ENOSPC\nprint('bounded')"
        result = self.run_python(code, limits=Limits(tmp_bytes=1024**2, scratch_bytes=1024**2))
        self.assertEqual(result.stdout, b"bounded\n", result.stderr)

    def test_memory_file_limits_and_node_address_space_compatibility(self):
        code = "import resource\nfor kind in [resource.RLIMIT_AS,resource.RLIMIT_FSIZE,resource.RLIMIT_CORE]:\n soft,hard=resource.getrlimit(kind);assert soft==hard\ntry:bytearray(512*1024*1024);raise AssertionError('unbounded memory')\nexcept MemoryError:print('bounded')"
        result = self.run_python(code, limits=Limits(address_space_bytes=128 * 1024**2))
        self.assertEqual(result.stdout, b"bounded\n", result.stderr)
        result = self.run_python("import os\nf=open('/scratch/file','wb')\ntry:f.write(b'x'*8192);f.flush();raise AssertionError('unbounded file')\nexcept OSError:print('bounded')", limits=Limits(file_bytes=4096))
        self.assertEqual(result.stdout, b"bounded\n", result.stderr)
        if Path("/usr/local/bin/node").exists():
            with GateSession(TrustedConfig("execution", self.source)) as gate:
                result = gate.run(ToolRequest(("/usr/local/bin/node", "-p", "process.version")))
                self.assertEqual(result.returncode, 0, result.stderr)

    def cli_command(self, *command, profile="execution"):
        return [sys.executable, "-m", "mirrorgate.cli", "run", "--profile", profile, "--workspace", str(self.source), "--", *command]

    def test_cli_preserves_bytes_and_bounds_consumer_backpressure(self):
        content = bytes(range(256)) * 1024
        process = subprocess.run(self.cli_command("/usr/bin/python3", "-c", "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())"), input=content, capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stdout, content)
        process = subprocess.Popen(self.cli_command("/usr/bin/python3", "-c", "import os;os.write(1,b'x'*100000)"), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(process.wait(timeout=5), 125)
        finally:
            process.kill() if process.poll() is None else None
            process.communicate(timeout=5)

    def test_cli_parent_death_kills_worker(self):
        code = "import time\nf=open('heartbeat','ab',buffering=0)\nfor _ in range(1000):f.write(b'x');time.sleep(.02)"
        temporary_root = self.root / "supervisor-temporary"
        temporary_root.mkdir()
        process = subprocess.Popen(self.cli_command("/usr/bin/python3", "-c", code, profile="authoring"), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, "TMPDIR": str(temporary_root)})
        try:
            heartbeat = self.source / "heartbeat"
            deadline = time.monotonic() + 3
            while not heartbeat.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(heartbeat.exists())
            process.kill()
            process.communicate(timeout=3)
            time.sleep(.1)
            first = heartbeat.read_bytes()
            time.sleep(.1)
            self.assertEqual(heartbeat.read_bytes(), first)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)


if __name__ == "__main__":
    unittest.main()
