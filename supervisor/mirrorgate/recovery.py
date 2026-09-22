"""Offline ownership-validated inspection and filesystem reclamation."""
from __future__ import annotations

from dataclasses import dataclass
import fcntl
import os
from pathlib import Path, PurePosixPath
import secrets
import stat
import time
from typing import Any, Callable

from .recovery_journal import (JournalBusy, JournalError, RecoveryJournal,
                               checked_relative_path, inspect_records,
                               validate_state_root)
from .cgroup import AggregateLimits, CgroupDelegation, CgroupSession
from .policy import AdmissionError
from .recovery_receipt import create_receipt


@dataclass(frozen=True)
class RecoveryItem:
    resource_id: str
    session_id: str
    kind: str
    phase: str
    disposition: str
    reason_code: str | None = None

    def public(self) -> dict[str, Any]:
        result = {"resourceId": self.resource_id, "sessionId": self.session_id,
                  "kind": self.kind, "phase": self.phase,
                  "disposition": self.disposition}
        if self.reason_code is not None:
            result["reasonCode"] = self.reason_code
        return result


def inspect(state_root: str | Path) -> dict[str, Any]:
    snapshot = inspect_records(state_root)
    live = _owner_busy(Path(state_root))
    items = [_classify(record, live=live).public() for record in snapshot.records]
    invalid = [{"record": item.name, "reasonCode": "record_invalid"}
               for item in snapshot.invalid]
    return {"schema": "mirrorgate.recovery-inspection/v1",
            "claims": items, "invalidRecords": invalid,
            "counts": _counts(items, invalid)}


def _counts(items: list[dict[str, Any]], invalid: list[dict[str, str]]) -> dict[str, int]:
    counts = {name: 0 for name in ("live", "abandoned", "retained", "reclaimed",
                                   "failed", "ambiguous", "invalid")}
    for item in items:
        disposition = item["disposition"]
        if disposition in counts:
            counts[disposition] += 1
    counts["invalid"] = len(invalid)
    return counts


def _owner_busy(root: Path) -> bool:
    _root, root_fd = validate_state_root(root)
    try:
        try:
            flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open("owner.lock", flags, dir_fd=root_fd)
        except FileNotFoundError:
            return False
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise JournalError("state-root lock identity is invalid")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
                return False
        finally:
            os.close(fd)
    finally:
        os.close(root_fd)


def _classify(record: dict[str, Any], *, live: bool = False) -> RecoveryItem:
    phase = record["phase"]
    if live and phase not in ("reclaimed", "ambiguous"):
        disposition, reason = "live", "live_owner"
    elif phase == "reclaimed":
        disposition, reason = "reclaimed", None
    elif phase == "retained_by_policy" and not record["retainedRecoverable"]:
        disposition, reason = "retained", "retained_by_policy"
    elif phase == "ambiguous":
        disposition, reason = "ambiguous", "ownership_ambiguous"
    elif phase == "cleanup_failed":
        disposition, reason = "failed", "prior_cleanup_failed"
    elif record["kind"] in ("process", "cgroup"):
        disposition, reason = "ambiguous", "post_restart_identity_unavailable"
    else:
        disposition, reason = "abandoned", None
    return RecoveryItem(record["resourceId"], record["sessionId"], record["kind"],
                        phase, disposition, reason)


def reclaim(state_root: str | Path, *, fault: Callable[[str], None] | None = None,
            cgroup_parent: str | Path | None = None,
            original: dict[str, Any] | None = None) -> dict[str, Any]:
    attempt_id = secrets.token_hex(16)
    results: list[dict[str, Any]] = []
    cgroup_observations: dict[str, dict[str, Any]] = {}
    with RecoveryJournal(state_root, role="recoverer", initialize=False) as journal:
        delegation = None if cgroup_parent is None else CgroupDelegation(cgroup_parent)
        with os.scandir(journal.quarantine_fd) as entries:
            if any(entry.name.startswith("invalid-") for entry in entries):
                raise JournalError("quarantined journal records require manual intervention")
        snapshot = journal.inspect()
        if snapshot.invalid:
            journal.quarantine_invalid(snapshot.invalid)
            raise JournalError("invalid journal records require manual intervention")
        plans: list[tuple[int, str, dict[str, Any]]] = []
        protected: list[tuple[str | None, dict[str, Any]]] = []
        for record in snapshot.records:
            if not _record_belongs_to_root(journal, record):
                results.append(_mark_ambiguous(journal, record, attempt_id,
                                               "foreign_root_or_uid"))
                protected.append((_record_path(record), record))
                continue
            item = _classify(record)
            if item.disposition in ("reclaimed", "retained"):
                results.append(item.public())
                if item.disposition == "retained":
                    protected.append((_record_path(record), record))
                continue
            if record["phase"] == "ambiguous":
                results.append(item.public())
                protected.append((_record_path(record), record))
                continue
            if record["kind"] not in ("filesystem", "retained_source"):
                if record["kind"] == "cgroup" and delegation is not None:
                    result, observation = _reclaim_cgroup(
                        journal, delegation, record, attempt_id)
                    results.append(result)
                    cgroup_observations[record["resourceId"]] = observation
                    if result["disposition"] != "reclaimed":
                        protected.append((None, record))
                    continue
                if record["kind"] == "cgroup" and record["phase"] == "cleanup_failed":
                    results.append(RecoveryItem(
                        record["resourceId"], record["sessionId"], "cgroup",
                        record["phase"], "failed", "prior_cleanup_failed").public())
                    protected.append((None, record))
                    continue
                results.append(_mark_ambiguous(journal, record, attempt_id,
                                               "post_restart_identity_unavailable"))
                protected.append((None, record))
                continue
            valid, reason, relative = _validate_filesystem(journal.root_fd, record)
            if not valid:
                results.append(_mark_ambiguous(journal, record, attempt_id, reason))
                protected.append((_record_path(record), record))
                continue
            assert relative is not None
            logical = record["identity"]["relativePath"]
            plans.append((len(PurePosixPath(logical).parts), logical, record))
        safe_plans = []
        for depth, relative, record in plans:
            blocked = False
            candidate = PurePosixPath(relative)
            for protected_path, protected_record in protected:
                if protected_path is not None:
                    child = PurePosixPath(protected_path)
                    if candidate == child or candidate in child.parents:
                        blocked = True
                elif (record["sessionId"] == protected_record["sessionId"]
                      or record["sessionId"] == "controller"):
                    blocked = True
                if blocked:
                    break
            if blocked:
                results.append(_mark_ambiguous(journal, record, attempt_id,
                                               "protected_descendant"))
            else:
                safe_plans.append((depth, record))
        # Remove only the outermost fully validated claim. Its exact tree contains
        # every grouped descendant claim, which is recorded terminal only after
        # the ancestor action succeeds.
        groups: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for _depth, record in sorted(safe_plans, key=lambda pair: pair[0]):
            path = PurePosixPath(record["identity"]["relativePath"])
            parent_group = next((group for group in groups
                                 if PurePosixPath(group[0]["identity"]["relativePath"])
                                 in path.parents), None)
            if parent_group is None:
                groups.append((record, []))
            else:
                parent_group[1].append(record)
        for record, descendants in groups:
            root_path = PurePosixPath(record["identity"]["relativePath"])
            group_target = PurePosixPath("quarantine") / ("reclaim-" + record["resourceId"])
            desired_descendants = []
            for descendant in descendants:
                descendant_path = PurePosixPath(descendant["identity"]["relativePath"])
                suffix = descendant_path.relative_to(root_path)
                desired_target = (group_target / suffix).as_posix()
                if (descendant["cleanupTarget"] is not None
                        and descendant["cleanupTarget"] != desired_target):
                    desired_descendants = []
                    break
                desired_descendants.append((descendant, desired_target))
            group_ready = len(desired_descendants) == len(descendants)
            prepared_descendants = []
            for descendant, desired_target in desired_descendants:
                current = descendant
                if current["phase"] != "cleanup_intent":
                    current = journal.transition(current["resourceId"], "cleanup_intent",
                                                 cleanup_target=desired_target)
                elif current["cleanupTarget"] is None:
                    current = journal.set_cleanup_target(current["resourceId"],
                                                         desired_target)
                elif current["cleanupTarget"] != desired_target:
                    group_ready = False
                    break
                prepared_descendants.append(current)
            if not group_ready:
                results.append(_mark_ambiguous(journal, record, attempt_id,
                                               "group_cleanup_target_conflict"))
                continue
            result = _reclaim_filesystem(journal, record, attempt_id, fault=fault)
            results.append(result)
            if result["disposition"] == "reclaimed":
                for current in prepared_descendants:
                    terminal = journal.transition(current["resourceId"], "reclaimed",
                        observation={"attemptId": attempt_id, "status": "recovered",
                                     "reasonCode": "ancestor_reclaimed"})
                    results.append(RecoveryItem(
                        terminal["resourceId"], terminal["sessionId"], terminal["kind"],
                        terminal["phase"], "reclaimed").public())
        if delegation is not None:
            delegation.close()
    public = [dict(item) for item in results]
    receipt_results = [{
        "resourceId": item["resourceId"],
        "sessionId": item["sessionId"],
        "kind": item["kind"],
        "result": item["disposition"],
        "reasonCode": item.get("reasonCode"),
    } for item in public]
    blank_settings = {name: None for name in
                      ("pids.max", "memory.max", "memory.swap.max", "cpu.max")}
    for item in receipt_results:
        if item["kind"] == "cgroup" and item["resourceId"] not in cgroup_observations:
            cgroup_observations[item["resourceId"]] = {
                "resourceId": item["resourceId"],
                "settings": dict(blank_settings),
                "counters": {},
            }
    receipt = create_receipt(
        attempt_id=attempt_id, trigger="offline_reclaim", original=original,
        results=receipt_results,
        remaining=[item["resourceId"] for item in public
                   if item["disposition"] in ("ambiguous", "failed", "unconfirmed")],
        ownership_observations=[item["disposition"] for item in public],
        cgroup_observations=[cgroup_observations[item["resourceId"]]
                             for item in receipt_results if item["kind"] == "cgroup"],
        controller_instance=journal.controller_instance, boot_id=journal.boot_id,
        principal_uid=journal.principal_uid)
    return {"schema": "mirrorgate.recovery-result/v1", "attemptId": attempt_id,
            "results": public,
            "counts": _counts(public, []), "receipt": receipt}


def _reclaim_cgroup(journal: RecoveryJournal, delegation: CgroupDelegation,
                    record: dict[str, Any], attempt_id: str) -> tuple[
                        dict[str, Any], dict[str, Any]]:
    identity = record["identity"]
    name = identity.get("relativePath")
    session = None
    fd = -1
    settings = {key: None for key in
                ("pids.max", "memory.max", "memory.swap.max", "cpu.max")}
    counters: dict[str, str | None] = {}
    if type(name) is not str:
        result = _mark_ambiguous(
            journal, record, attempt_id, "cgroup_identity_unconfirmed")
        return result, {"resourceId": record["resourceId"],
                        "settings": settings, "counters": counters}
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
                     | os.O_NOFOLLOW, dir_fd=delegation.fd)
        info = os.fstat(fd)
        expected = (identity["device"], identity["inode"], identity["mode"])
        actual = (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))
        if actual != expected:
            os.close(fd)
            fd = -1
            raise JournalError("cgroup identity changed")
        session = CgroupSession(delegation, name, record["sessionId"],
                                AggregateLimits(1, 1, 1, 1000), fd)
        settings = session.settings()
    except (OSError, JournalError, AdmissionError):
        if session is not None and session.fd >= 0:
            os.close(session.fd)
            session.fd = -1
        elif fd >= 0:
            os.close(fd)
        result = _mark_ambiguous(
            journal, record, attempt_id, "cgroup_identity_unconfirmed")
        return result, {"resourceId": record["resourceId"],
                        "settings": settings, "counters": counters}
    try:
        journal.begin_cleanup(record["resourceId"])
        try:
            counters = session.cleanup()
        except (OSError, AdmissionError):
            try:
                counters = session.observe()
            except (OSError, AdmissionError):
                counters = {}
            failed = journal.finish_cleanup(record["resourceId"], complete=False)
            result = RecoveryItem(
                failed["resourceId"], failed["sessionId"], failed["kind"],
                failed["phase"], "failed", "cgroup_cleanup_failed").public()
            return result, {"resourceId": record["resourceId"],
                            "settings": settings, "counters": counters}
        terminal = journal.finish_cleanup(record["resourceId"], complete=True)
        result = RecoveryItem(
            terminal["resourceId"], terminal["sessionId"], terminal["kind"],
            terminal["phase"], "reclaimed").public()
        return result, {"resourceId": record["resourceId"],
                        "settings": settings, "counters": counters}
    finally:
        if session.fd >= 0:
            os.close(session.fd)
            session.fd = -1


def _mark_ambiguous(journal: RecoveryJournal, record: dict[str, Any],
                    attempt_id: str, reason: str) -> dict[str, Any]:
    if record["phase"] not in ("ambiguous", "reclaimed"):
        record = journal.transition(record["resourceId"], "ambiguous",
            observation={"attemptId": attempt_id, "status": "ambiguous",
                         "reasonCode": reason})
    item = RecoveryItem(record["resourceId"], record["sessionId"], record["kind"],
                        record["phase"], "ambiguous", reason)
    return item.public()


def _record_belongs_to_root(journal: RecoveryJournal, record: dict[str, Any]) -> bool:
    return (record["principalUid"] == journal.principal_uid
            and record["stateRoot"] == journal.state_root_identity)


def _record_path(record: dict[str, Any]) -> str | None:
    identity = record.get("identity")
    if type(identity) is dict and type(identity.get("relativePath")) is str:
        return identity["relativePath"]
    return None


def _validate_filesystem(root_fd: int, record: dict[str, Any]) -> tuple[bool, str, str | None]:
    identity = record["identity"]
    if not identity:
        return False, "identity_incomplete", None
    original = checked_relative_path(identity["relativePath"])
    if not original.startswith("resources/"):
        return False, "path_outside_resources", None
    candidates = [original]
    if record["cleanupTarget"] is not None:
        candidates.append(checked_relative_path(record["cleanupTarget"]))
    matches = []
    for relative in candidates:
        try:
            parent_fd, leaf = _open_parent(root_fd, relative)
            try:
                flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                object_fd = os.open(leaf, flags, dir_fd=parent_fd)
                try:
                    current = os.fstat(object_fd)
                    token = os.getxattr(object_fd, "user.mirrorgate.identity").decode("ascii")
                finally:
                    os.close(object_fd)
            finally:
                os.close(parent_fd)
        except FileNotFoundError:
            continue
        except (OSError, JournalError):
            return False, "path_validation_failed", None
        if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode):
            return False, "object_type_changed", None
        expected = (identity["device"], identity["inode"], identity["mode"],
                    identity["ownershipToken"])
        actual = (current.st_dev, current.st_ino, stat.S_IFMT(current.st_mode), token)
        if expected == actual:
            matches.append(relative)
        else:
            return False, "object_identity_changed", None
    if len(matches) == 0:
        return False, "object_missing_unconfirmed", None
    if len(matches) != 1:
        return False, "duplicate_object_identity", None
    return True, "", matches[0]


def _open_parent(root_fd: int, relative: str) -> tuple[int, str]:
    parts = PurePosixPath(checked_relative_path(relative)).parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def _reclaim_filesystem(journal: RecoveryJournal, record: dict[str, Any],
                        attempt_id: str, *, fault: Callable[[str], None] | None = None) -> dict[str, Any]:
    def cut(name: str) -> None:
        if fault is not None:
            fault(name)
    valid, reason, located = _validate_filesystem(journal.root_fd, record)
    if not valid:
        return _mark_ambiguous(journal, record, attempt_id, reason)
    current = record
    quarantine_name = "reclaim-" + current["resourceId"]
    cleanup_target = "quarantine/" + quarantine_name
    if current["phase"] != "cleanup_intent":
        if current["phase"] == "cleanup_failed":
            current = journal.transition(current["resourceId"], "cleanup_intent",
                                         cleanup_target=cleanup_target)
        elif current["phase"] in ("allocation_intent", "durable_owned", "active"):
            current = journal.transition(current["resourceId"], "cleanup_intent",
                                         cleanup_target=cleanup_target)
        elif current["phase"] == "retained_by_policy" and current["retainedRecoverable"]:
            current = journal.transition(current["resourceId"], "cleanup_intent",
                                         cleanup_target=cleanup_target)
        else:
            return _mark_ambiguous(journal, current, attempt_id, "transition_invalid")
    elif current["cleanupTarget"] is None:
        current = journal.set_cleanup_target(current["resourceId"], cleanup_target)
    cut("after-cleanup-intent")
    valid, reason, located = _validate_filesystem(journal.root_fd, current)
    if not valid or located is None:
        return _mark_ambiguous(journal, current, attempt_id, reason)
    relative = located
    parent_fd, leaf = _open_parent(journal.root_fd, relative)
    quarantine_fd = os.dup(journal.quarantine_fd)
    pinned_fd = -1
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        pinned_fd = os.open(leaf, flags, dir_fd=parent_fd)
        observed = os.fstat(pinned_fd)
        identity = current["identity"]
        observed_identity = (observed.st_dev, observed.st_ino,
                             stat.S_IFMT(observed.st_mode),
                             os.getxattr(pinned_fd, "user.mirrorgate.identity").decode("ascii"))
        expected_identity = (identity["device"], identity["inode"], identity["mode"],
                             identity["ownershipToken"])
        if observed_identity != expected_identity:
            return _mark_ambiguous(journal, current, attempt_id,
                                   "object_identity_changed")
        if relative != cleanup_target:
            cut("before-rename")
            try:
                os.rename(leaf, quarantine_name, src_dir_fd=parent_fd,
                          dst_dir_fd=quarantine_fd)
            except OSError:
                failed = journal.transition(current["resourceId"], "cleanup_failed",
                    observation={"attemptId": attempt_id, "status": "failed",
                                 "reasonCode": "rename_failed"})
                return RecoveryItem(failed["resourceId"], failed["sessionId"],
                                    failed["kind"], failed["phase"], "failed",
                                    "rename_failed").public()
            cut("after-rename")
        moved = os.stat(quarantine_name, dir_fd=quarantine_fd, follow_symlinks=False)
        if (moved.st_dev, moved.st_ino, stat.S_IFMT(moved.st_mode)) != (
                identity["device"], identity["inode"], identity["mode"]):
            return _mark_ambiguous(journal, current, attempt_id,
                                   "quarantine_identity_changed")
        budget = {"entries": 0, "deadline": time.monotonic() + 10.0}
        _remove_tree_at(quarantine_fd, quarantine_name,
                        expected_device=identity["device"],
                        expected_uid=current["principalUid"], budget=budget)
        cut("after-remove")
    except OSError:
        failed = journal.transition(current["resourceId"], "cleanup_failed",
            observation={"attemptId": attempt_id, "status": "failed",
                         "reasonCode": "removal_failed"})
        return RecoveryItem(failed["resourceId"], failed["sessionId"],
                            failed["kind"], failed["phase"], "failed",
                            "removal_failed").public()
    finally:
        if pinned_fd >= 0:
            os.close(pinned_fd)
        os.close(quarantine_fd)
        os.close(parent_fd)
    terminal = journal.transition(current["resourceId"], "reclaimed",
        observation={"attemptId": attempt_id, "status": "recovered",
                     "reasonCode": None})
    cut("after-terminal-record")
    return RecoveryItem(terminal["resourceId"], terminal["sessionId"],
                        terminal["kind"], terminal["phase"], "reclaimed").public()


def _remove_tree_at(parent_fd: int, name: str, *, expected_device: int,
                    expected_uid: int, budget: dict[str, Any], depth: int = 0) -> None:
    if depth > 64 or budget["entries"] > 10_000 or time.monotonic() > budget["deadline"]:
        raise OSError("bounded recovery removal exceeded")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(name, flags, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if opened.st_dev != expected_device or opened.st_uid != expected_uid:
            raise OSError("recovery removal crossed ownership or mount boundary")
        os.fchmod(fd, 0o700)
        for child in os.listdir(fd):
            budget["entries"] += 1
            if budget["entries"] > 10_000 or time.monotonic() > budget["deadline"]:
                raise OSError("bounded recovery removal exceeded")
            info = os.stat(child, dir_fd=fd, follow_symlinks=False)
            if info.st_dev != expected_device or info.st_uid != expected_uid:
                raise OSError("recovery removal crossed ownership or mount boundary")
            if stat.S_ISDIR(info.st_mode):
                _remove_tree_at(fd, child, expected_device=expected_device,
                                expected_uid=expected_uid, budget=budget,
                                depth=depth + 1)
            else:
                os.unlink(child, dir_fd=fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent_fd)
