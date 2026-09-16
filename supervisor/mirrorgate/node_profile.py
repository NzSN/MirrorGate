"""Operator-admitted Node source-copy preparation; never executes submitted code."""
from __future__ import annotations
import hashlib
from pathlib import Path, PurePosixPath
import shutil
import stat
from .policy import AdmissionError


def runtime_binary(runtime) -> Path:
    command = PurePosixPath(runtime.command[0])
    mounts = sorted(runtime.runtime_mounts, key=lambda item: len(item.destination), reverse=True)
    for mount in mounts:
        try:
            relative = command.relative_to(mount.destination)
        except ValueError:
            continue
        current = Path(mount.source)
        for part in relative.parts:
            current /= part
            if stat.S_ISLNK(current.lstat().st_mode):
                raise AdmissionError("Node runtime executable contains a symlink")
        if not current.is_file():
            raise AdmissionError("Node runtime executable is not a regular file")
        return current
    raise AdmissionError("Node runtime executable is outside admitted runtime roots")


def copy_selected(source: Path, output: Path, files: tuple[str, ...]) -> None:
    for relative in files:
        path = source
        for part in PurePosixPath(relative).parts:
            path /= part
            if stat.S_ISLNK(path.lstat().st_mode):
                raise AdmissionError("Node source selection contains a symlink")
        if not path.is_file():
            raise AdmissionError("Node source selection must name regular files")
        target = output / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open("rb") as incoming, target.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing, 65536)
        target.chmod(0o400)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1048576), b""):
            digest.update(block)
    return digest.hexdigest()


def public_environment(state) -> dict:
    """Only schema-approved logical paths and public policy metadata escape."""
    return {
        "schema": "mirrorgate.public-environment/v1",
        "profileId": state.build_plan.profile if state.build_plan else "prebuilt/v1",
        "stages": {
            "authoring": {"root": "/workspace", "writable": ["/workspace", "/tmp", "/scratch"]},
            "build": {"root": "/source", "writable": ["/output", "/tmp", "/scratch"]},
            "execution": {"root": "/artifact", "writable": ["/tmp", "/scratch"]},
        },
        "entryPoint": state.runtime.artifact_entry,
        "tools": list(state.policy.tools),
        "limits": state.limits.as_wire(),
    }
