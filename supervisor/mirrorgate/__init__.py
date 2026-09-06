"""MirrorGate trusted supervisor API."""
from .artifacts import FrozenArtifact, freeze_tree
from .policy import AdmissionError, Limits, RuntimeMount, ToolRequest, TrustedConfig, system_runtime_mounts

__all__ = ["AdmissionError", "FrozenArtifact", "GateSession", "Limits", "RunResult", "RuntimeMount", "SandboxProcess", "ToolRequest", "TrustedConfig", "freeze_tree", "system_runtime_mounts"]


def __getattr__(name):
    # Avoid importing sandbox before the internal `-m mirrorgate.sandbox` helper.
    if name in ("GateSession", "RunResult", "SandboxProcess"):
        from . import sandbox
        return getattr(sandbox, name)
    raise AttributeError(name)
