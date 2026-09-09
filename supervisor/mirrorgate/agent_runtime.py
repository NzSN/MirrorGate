"""Audited Codex process adapter, private config staging, and selective teardown.

The controller is trusted. Only its three MCP tools can access submission resources;
those calls use the already admitted Bubblewrap backend, never a local fallback.
"""
from __future__ import annotations
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

from .agent_policy import AgentAdmission, AgentProfile, file_digest, read_regular
from .authoring_broker import AuthoringBroker, strict_json, tool_definitions
from .policy import AdmissionError, Limits
from .sandbox import SandboxProcess

ADAPTER_REVISION = "mirrorgate.codex-host/v1"
PROBE_REVISION = "mirrorgate.codex-dispatch/v1"
FLAGS = ["exec", "--strict-config", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--json"]
ENV_KEYS = ["PATH", "HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"]
INSTRUCTIONS = """Implement the approved public task using only Gate tools. First read public_contract,
which contains the requirements, public files, and approved tool IDs. All implementation
file access, development and tests must use gate_exec in the restricted workspace.
When ready, call submit to seal the source. No authoring is possible afterward.
Do not request private evaluator materials. Return a short factual summary."""

DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'view_image', 'apps', 'plugins', 'connectors', 'browser_use', 'computer_use', 'image_generation', 'imagegenext', 'web_search', 'standalone_web_search', 'js_repl', 'js_repl_tools_only', 'multi_agent', 'multi_agent_v2', 'collab', 'multi_agent_mode', 'enable_fanout', 'memories', 'memory_tool', 'external_agent_memory_import', 'skill_search', 'skill_mcp_dependency_install', 'skill_env_var_dependency_prompt', 'codex_hooks', 'hooks', 'plugin_hooks', 'request_permissions', 'request_permissions_tool', 'tool_suggest', 'recommended_plugins', 'tool_search', 'search_tool', 'code_mode', 'code_mode_only', 'goals', 'token_budget', 'context_management', 'remote_control', 'in_app_browser', 'in_app_chat', 'realtime_conversation', 'shell_snapshot', 'shell_snapshot_v2', 'workspace_dependencies', 'remote_models', 'personality', 'current_time_reminder', 'sleep_tool']


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def selected_catalog(profile: AgentProfile):
    try:
        raw = strict_json(read_regular(profile.model_catalog, maximum=8 * 1048576))
        if type(raw) is not dict or type(raw.get("models")) is not list:
            raise ValueError("invalid catalog")
        matches = [model for model in raw["models"] if type(model) is dict and model.get("slug") == profile.model]
    except (ValueError, TypeError, KeyError) as exc:
        raise AdmissionError("agent model catalog is invalid") from exc
    if len(matches) != 1:
        raise AdmissionError("agent model is absent from approved catalog")
    model = dict(matches[0])
    model.update({"shell_type": "disabled", "apply_patch_tool_type": None,
        "experimental_supported_tools": [], "include_skills_usage_instructions": False,
        "include_plugin_usage_instructions": False, "include_apps_usage_instructions": False,
        "supports_search_tool": False, "node_repl_disabled": True, "tool_mode": "direct",
        "use_responses_lite": False, "multi_agent_version": "disabled", "multi_agent_reasoning_effort": None})
    return {"models": [model]}


def config_text(profile: AgentProfile, home: Path, support: Path, broker: Path, token: str) -> str:
    q = lambda value: json.dumps(str(value))
    return "\n".join([
        f"model = {q(profile.model)}", 'model_reasoning_effort = "high"',
        'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
        'project_doc_max_bytes = 0', f"model_catalog_json = {q(home / 'models.json')}",
        f"model_instructions_file = {q(home / 'instructions.txt')}",
        'include_apps_instructions = false', 'suppress_unstable_features_warning = true',
        '[features]', *[f"{key} = false" for key in DISABLED_FEATURES],
        'skip_host_skill_discovery = true', '[tools.update_plan]', 'enabled = false',
        '[tools.experimental_request_user_input]', 'enabled = false',
        '[mcp_servers.gate_author]', f"command = {q(Path(sys.executable).resolve())}",
        f"args = [{q(support / 'authoring_mcp.py')}, \"--broker\", {q(broker)}, \"--token\", {q(token)}]",
        'enabled = true', 'required = true', 'enabled_tools = ["public_contract", "gate_exec", "submit"]',
        'default_tools_approval_mode = "approve"', 'supports_parallel_tool_calls = false',
        'startup_timeout_sec = 20', 'tool_timeout_sec = 90', ""])


def runtime_identity(profile: AgentProfile) -> dict[str, Any]:
    root = Path(__file__).parent
    # Identity includes exact adapter and broker bytes; changing any invalidates admission.
    support = {name: file_digest(root / name) for name in (
        "agent_runtime.py", "agent_policy.py", "agent_audit.py", "agent_trampoline.py", "authoring_broker.py", "authoring_mcp.py")}
    identity = {"adapterRevision": ADAPTER_REVISION, "executableSha256": file_digest(profile.executable),
        "version": profile.version, "model": profile.model,
        "catalogSha256": hashlib.sha256(canonical(selected_catalog(profile))).hexdigest(),
        "templateSha256": hashlib.sha256(config_text(profile, Path("/HOME"), Path("/SUPPORT"), Path("/BROKER"), "TOKEN").encode()).hexdigest(),
        "support": support, "pythonSha256": file_digest(Path(sys.executable).resolve()),
        "toolsSha256": hashlib.sha256(canonical(tool_definitions())).hexdigest(), "flags": FLAGS,
        "environmentKeys": ENV_KEYS, "context": "fresh-private-cwd/no-inherited-home/no-project-docs/no-rules/no-skills/no-memory",
        "backend": "linux-bubblewrap-v1", "profileId": profile.id,
        "credentialRevision": profile.credential_revision,
        "credentialProviderSha256": hashlib.sha256(canonical({"kind": "codex-auth-file-v1",
            "path": str(profile.credential_file), "revision": profile.credential_revision})).hexdigest()}
    return identity


def verify_receipt(profile: AgentProfile, identity: dict) -> None:
    try:
        receipt = strict_json(read_regular(profile.audit_receipt, maximum=65536, private=True))
        if type(receipt) is not dict or set(receipt) != {"schema", "probeRevision", "identity", "passed", "auditedAt"}:
            raise ValueError("invalid receipt")
        if (receipt["schema"] != "mirrorgate.agent-audit/v1" or receipt["probeRevision"] != PROBE_REVISION
                or receipt["identity"] != identity or receipt["passed"] is not True
                or type(receipt["auditedAt"]) not in (int, float)
                or not 0 <= time.time() - receipt["auditedAt"] <= profile.audit_max_age_seconds):
            raise ValueError("receipt mismatch")
    except (ValueError, TypeError, KeyError) as exc:
        raise AdmissionError("agent runtime audit is unavailable or stale") from exc


class HostedProcess(SandboxProcess):
    """Signal the owned subreaper, allowing it to quiesce escaped descendants."""
    def __init__(self, process, limits, *, cancel_event=None):
        self.cleanup_deadline = None
        self._cancel_event = cancel_event
        # Pin before starting the monitor, which is the only process reaper.
        # A numeric PID may belong to an unrelated peer after that reap.
        self._pidfd = os.pidfd_open(process.pid, 0)
        try:
            super().__init__(process, limits)
        except BaseException:
            os.close(self._pidfd)
            self._pidfd = None
            raise

    def _monitor(self):
        try:
            super()._monitor()
        finally:
            with self._lock:
                descriptor, self._pidfd = self._pidfd, None
            if descriptor is not None:
                os.close(descriptor)

    def wait(self, timeout=None):
        started = time.monotonic()
        code = super().wait(timeout)
        # The base completion event precedes this class's pidfd finalizer.
        # A successful wait also joins that last owned resource release.
        remaining = None if timeout is None else max(0, timeout - (time.monotonic() - started))
        self._thread.join(remaining)
        if self._thread.is_alive():
            raise TimeoutError("host monitor has not finished cleanup")
        return code

    def _terminate(self, reason: str) -> None:
        with self._lock:
            # Revoke pending broker callbacks before signaling or joining the
            # runtime. They must not commit source during failure cleanup.
            if self._cancel_event is not None:
                self._cancel_event.set()
            if self.returncode is not None or self.process.returncode is not None or self._pidfd is None:
                return
            if self.reason == "exited":
                self.reason = reason
            if self.cleanup_deadline is None:
                self.cleanup_deadline = time.monotonic() + 5
            try:
                signal.pidfd_send_signal(self._pidfd, signal.SIGTERM if time.monotonic() < self.cleanup_deadline else signal.SIGKILL)
            except ProcessLookupError:
                pass

    def terminate(self):
        self._terminate("terminated")


@dataclass(frozen=True)
class HostResult:
    returncode: int | None
    reason: str
    cleanup_complete: bool
    remaining_resources: tuple[str, ...]


class AgentHost:
    def __init__(self, admission: AgentAdmission, *, execute, submit, tool_ids: tuple[str, ...],
                 deadline: float, cancel_event: threading.Event, stop_authoring=None):
        self.admission = admission
        self.execute = execute
        self.submit = submit
        self.tool_ids = tool_ids
        self.deadline = min(deadline, time.monotonic() + admission.limits["wallMs"] / 1000)
        self.cancel_event = cancel_event
        self.stop_authoring = stop_authoring
        self.root = None
        self.broker = None
        self.process = None
        self._unmonitored_process = None
        self.receipt_token = secrets.token_hex(32)

    def _stage(self, *, credential=True):
        profile = self.admission.profile
        if runtime_identity(profile) != self.admission.identity:
            raise AdmissionError("agent runtime identity changed before launch")
        self.root = Path(tempfile.mkdtemp(prefix="mg-agent-", dir="/tmp"))
        self.root.chmod(0o700)
        for name in ("cwd", "home", "config", "data", "cache", "tmp", "support"):
            (self.root / name).mkdir(mode=0o700)
        executable = self.root / "codex"
        with profile.executable.open("rb") as src, executable.open("xb") as dst:
            shutil.copyfileobj(src, dst, 1048576)
        executable.chmod(0o500)
        if file_digest(executable) != self.admission.identity["executableSha256"]:
            raise AdmissionError("agent executable changed during pinning")
        support = self.root / "support"
        for name in ("authoring_mcp.py", "authoring_broker.py", "agent_trampoline.py"):
            data = read_regular(Path(__file__).with_name(name), maximum=1048576)
            if hashlib.sha256(data).hexdigest() != self.admission.identity["support"][name]:
                raise AdmissionError("broker dependency changed during pinning")
            (support / name).write_bytes(data)
            (support / name).chmod(0o400)
        catalog = canonical(selected_catalog(profile))
        if hashlib.sha256(catalog).hexdigest() != self.admission.identity["catalogSha256"]:
            raise AdmissionError("agent catalog changed during pinning")
        home = self.root / "home"
        (home / "models.json").write_bytes(catalog)
        (home / "instructions.txt").write_text(INSTRUCTIONS)
        if credential:
            credential_bytes = read_regular(profile.credential_file, maximum=1048576, private=True)
            fd = os.open(home / "auth.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as dst:
                dst.write(credential_bytes)
        self.broker = AuthoringBroker(self.root, contract=self.admission.task,
                                     execute=self.execute, submit=self.submit, tool_ids=self.tool_ids)
        (home / "config.toml").write_text(config_text(profile, home, support, self.broker.path, self.broker.token))
        (home / "config.toml").chmod(0o600)
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.root / "cwd"), "CODEX_HOME": str(home),
               "XDG_CONFIG_HOME": str(self.root / "config"), "XDG_DATA_HOME": str(self.root / "data"),
               "XDG_CACHE_HOME": str(self.root / "cache"), "TMPDIR": str(self.root / "tmp")}
        version = subprocess.run([str(executable), "--version"], env={**env, "CODEX_HOME": str(self.root / "cache")}, cwd=self.root / "cwd",
                                 capture_output=True, timeout=5, close_fds=True)
        if version.returncode or version.stdout.decode().strip() != profile.version:
            raise AdmissionError("agent version does not match audited runtime")
        return [str(executable), *FLAGS, "-C", str(self.root / "cwd")], env

    def _check_fresh_context(self):
        # Codex always loads CODEX_HOME/AGENTS.md even with project_doc_max_bytes=0.
        # This directory is private Gate-owned staging: reject all unexpected inputs
        # before the actual dispatcher starts rather than relying on that setting.
        allowed = {"models.json", "instructions.txt", "config.toml", "auth.json"}
        if (any(path.name not in allowed or path.is_symlink() or not path.is_file()
                for path in (self.root / "home").iterdir())
                or any((self.root / "cwd").iterdir())):
            raise AdmissionError("agent initial context is not pristine")

    def _execute(self, command, env, prompt: bytes, *, capture=False):
        self._check_fresh_context()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0 or self.cancel_event.is_set():
            reason = "cancelled" if self.cancel_event.is_set() else "wall_timeout"
            self.cancel_event.set()
            return None, reason, {}, None
        trampoline = self.root / "support" / "agent_trampoline.py"
        if not trampoline.is_file():
            raise AdmissionError("owned runtime trampoline is unavailable")
        launch = [str(Path(sys.executable).resolve()), str(trampoline), "--receipt", str(self.root / "cleanup.json"),
                  "--token", self.receipt_token, "--", *command]
        proc = subprocess.Popen(launch, cwd=self.root / "cwd", env=env, close_fds=True,
                                start_new_session=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, bufsize=0)
        try:
            self.process = HostedProcess(proc, Limits(wall_seconds=remaining,
                stdout_bytes=self.admission.limits["stdoutBytes"], stderr_bytes=self.admission.limits["stderrBytes"]),
                cancel_event=self.cancel_event)
        except BaseException:
            # Preserve the child if monitor/pidfd setup fails after Popen. The
            # cleanup path must still stop/reap it and require a descendant receipt.
            self._unmonitored_process = proc
            self.cancel_event.set()
            raise
        output = {"stdout": bytearray(), "stderr": bytearray()}
        def drain(name, reader):
            while chunk := reader():
                if capture:
                    output[name].extend(chunk)
        threads = [threading.Thread(target=drain, args=(name, getattr(self.process, "read_" + name)), daemon=True)
                   for name in output]
        for thread in threads:
            thread.start()
        # Input is bounded public text. A stuck stdin cannot block cancellation/monitoring.
        def write():
            try:
                self.process.write(prompt)
                self.process.close_stdin(terminate_after_grace=False)
            except (BrokenPipeError, OSError):
                pass
        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        submitted_at = None
        while True:
            if self.broker is not None and self.broker.submitted.is_set():
                if submitted_at is None:
                    submitted_at = time.monotonic()
                elif time.monotonic() - submitted_at >= 1:
                    self.process.cancel()
            if self.cancel_event.is_set():
                self.process.cancel()
            try:
                code = self.process.wait(.05)
                break
            except TimeoutError:
                continue
        self.cancel_event.set()  # Natural exit also revokes any unfinished submit.
        for thread in threads:
            thread.join(1)
        writer.join(1)
        return code, self.process.reason, output, proc.pid

    def cleanup(self) -> tuple[bool, tuple[str, ...]]:
        remaining = []
        self.cancel_event.set()
        deadline = time.monotonic() + 5
        if self.process is not None:
            self.process.terminate()
            if self.process.cleanup_deadline is not None:
                deadline = min(deadline, self.process.cleanup_deadline)
            try:
                self.process.wait(max(0, deadline - time.monotonic()))
            except TimeoutError:
                self.process.cancel()
                remaining.append("agent-process")
        elif self._unmonitored_process is not None:
            proc = self._unmonitored_process
            try:
                # No monitor was installed, so this is the exclusive reaper.
                # Popen avoids signaling an already-reaped direct child.
                proc.terminate()
                try:
                    proc.wait(timeout=max(0, deadline - time.monotonic() - 1))
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=max(0, deadline - time.monotonic()))
            except (OSError, subprocess.TimeoutExpired):
                remaining.append("agent-process")
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream is not None:
                        stream.close()
        if self.process is not None or self._unmonitored_process is not None:
            try:
                receipt = strict_json(read_regular(self.root / "cleanup.json", maximum=4096, private=True))
                if (set(receipt) != {"token", "complete", "teardownStarted", "leaderCode"}
                        or not secrets.compare_digest(receipt["token"], self.receipt_token)
                        or receipt["complete"] is not True or type(receipt["teardownStarted"]) not in (int, float)):
                    raise ValueError("invalid cleanup receipt")
                deadline = min(deadline, receipt["teardownStarted"] + 5)
            except (AdmissionError, ValueError, TypeError, KeyError):
                remaining.append("agent-descendants")
        if self.stop_authoring is not None:
            try:
                self.stop_authoring(deadline)
            except Exception:
                remaining.append("authoring-process")
        if self.broker is not None and not self.broker.close(max(0, deadline - time.monotonic())):
            remaining.append("authoring-broker")
        if self.root is not None:
            try:
                (self.root / "home" / "auth.json").unlink(missing_ok=True)
                shutil.rmtree(self.root)
            except OSError:
                remaining.append("agent-host-directory")
        return not remaining, tuple(remaining)

    def run(self) -> HostResult:
        code, reason = None, "start_failed"
        try:
            verify_receipt(self.admission.profile, self.admission.identity)
            command, env = self._stage()
            code, reason, _, _ = self._execute(command + ["-"], env,
                b"Read the approved public_contract, implement it through gate_exec, run public checks, and submit.\n")
        except Exception:
            # Never expose credentials, argv, private paths or raw controller diagnostics.
            reason = "start_failed"
        finally:
            complete, remaining = self.cleanup()
        return HostResult(code, reason, complete, remaining)
