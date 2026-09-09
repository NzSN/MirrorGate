"""Closed, operator-owned managed-agent profiles and admission bounds."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any

from .control_policy import _id, _object, checked_relative_path
from .policy import AdmissionError

LIMIT_CEILINGS = {"wallMs": 300000, "stdoutBytes": 1048576, "stderrBytes": 1048576,
                  "progressRecords": 256, "progressBytes": 262144, "progressRecordBytes": 16384}


def agent_limits(value: Any, ceilings: dict[str, int] | None = None, *, partial: bool = False) -> dict[str, int]:
    ceilings = LIMIT_CEILINGS if ceilings is None else ceilings
    if type(value) is not dict or set(value) - set(ceilings) or (not partial and set(value) != set(ceilings)):
        raise AdmissionError("agent limits fields are invalid")
    result = dict(ceilings)
    for key, number in value.items():
        if type(number) is not int or not 1 <= number <= ceilings[key]:
            raise AdmissionError("agent limits may only tighten operator ceilings")
        result[key] = number
    return result


def public_task(value: Any) -> dict[str, Any]:
    raw = _object(value, {"instructions", "files"}, "public task")
    def utf8(text, limit):
        try:
            if type(text) is not str or "\0" in text or len(text.encode("utf-8")) > limit:
                raise AdmissionError("public task text exceeds its bound")
        except UnicodeError as exc:
            raise AdmissionError("public task contains invalid Unicode") from exc
    utf8(raw["instructions"], 65536)
    if type(raw["files"]) is not list or len(raw["files"]) > 128:
        raise AdmissionError("public task files exceed their bound")
    files, paths, total = [], set(), 0
    for item in raw["files"]:
        item = _object(item, {"path", "text"}, "public task file")
        path = checked_relative_path(item["path"])
        if path == "." or path.split("/")[0] == ".mirrorgate" or path in paths:
            raise AdmissionError("public task path is reserved or duplicated")
        if any(path.startswith(old + "/") or old.startswith(path + "/") for old in paths):
            raise AdmissionError("public task paths conflict")
        utf8(item["text"], 262144)
        total += len(item["text"].encode("utf-8"))
        if total > 262144:
            raise AdmissionError("public task files exceed their byte bound")
        paths.add(path)
        files.append({"path": path, "text": item["text"]})
    return {"instructions": raw["instructions"], "files": files}


def read_regular(path: Path, *, maximum: int, private: bool = False) -> bytes:
    """No symlink/file replacement between identity check and bounded read."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
                raise AdmissionError("agent profile input is not a bounded regular file")
            if private and (info.st_uid != os.getuid() or info.st_mode & 0o077):
                raise AdmissionError("agent credentials require private owner-only permissions")
            data = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
            if len(data) > maximum or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise AdmissionError("agent profile input changed while reading")
            return data
    except OSError as exc:
        raise AdmissionError("agent profile input is unavailable") from exc


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise AdmissionError("agent runtime must be a regular file")
            while chunk := stream.read(1048576):
                digest.update(chunk)
            after = os.fstat(stream.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise AdmissionError("agent runtime changed while hashing")
    except OSError as exc:
        raise AdmissionError("agent runtime is unavailable") from exc
    return digest.hexdigest()


@dataclass(frozen=True)
class AgentAdmission:
    profile: "AgentProfile"
    identity: dict[str, Any]
    limits: dict[str, int]
    task: dict[str, Any]


@dataclass(frozen=True)
class AgentProfile:
    id: str
    runtime: str
    executable: Path
    version: str
    model: str
    model_catalog: Path
    credential_file: Path
    audit_receipt: Path
    audit_max_age_seconds: int
    credential_revision: str
    limits: dict[str, int]

    @classmethod
    def parse(cls, value: Any) -> "AgentProfile":
        raw = _object(value, {"id", "runtime", "executable", "version", "model", "modelCatalog",
                              "credentialFile", "auditReceipt", "auditMaxAgeSeconds", "credentialRevision", "limits"}, "agent profile")
        if raw["runtime"] != "codex" or raw["version"] != "codex-cli 0.153.4":
            raise AdmissionError("unsupported managed agent runtime")
        for name in ("model", "credentialRevision"):
            _id(raw[name], name)
        for name in ("executable", "modelCatalog", "credentialFile", "auditReceipt"):
            if type(raw[name]) is not str or not Path(raw[name]).is_absolute() or "\0" in raw[name]:
                raise AdmissionError("agent profile paths must be absolute operator selections")
        age = raw["auditMaxAgeSeconds"]
        if type(age) is not int or not 1 <= age <= 86400:
            raise AdmissionError("agent audit age must not exceed 24 hours")
        return cls(_id(raw["id"], "profile id"), raw["runtime"], Path(raw["executable"]), raw["version"], raw["model"],
                   Path(raw["modelCatalog"]), Path(raw["credentialFile"]), Path(raw["auditReceipt"]), age,
                   raw["credentialRevision"], agent_limits(raw["limits"]))

    def admit(self, task: Any, limits: Any = None) -> AgentAdmission:
        from .agent_runtime import runtime_identity, verify_receipt
        task = public_task(task)
        effective = agent_limits({} if limits is None else limits, self.limits, partial=True)
        identity = runtime_identity(self)
        verify_receipt(self, identity)
        # Resolution only; no credential content is included in identity or receipts.
        read_regular(self.credential_file, maximum=1048576, private=True)
        return AgentAdmission(self, identity, effective, task)
