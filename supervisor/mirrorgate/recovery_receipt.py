"""Closed private recovery receipt and allowlisted public projection."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .policy import AdmissionError


SCHEMA = "mirrorgate.recovery-receipt/v1"
PUBLIC_SCHEMA = "mirrorgate.recovery-public/v1"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
RESULTS = {"reclaimed", "failed", "ambiguous", "retained", "unconfirmed"}
BEHAVIORS = {"passed", "failed", "inconclusive", "not_run"}
CLEANUPS = {"confirmed", "failed", "unconfirmed", "not_applicable"}
CGROUP_KINDS = {"cgroup", "cgroup-v2"}
CGROUP_SETTINGS = frozenset(
    ("pids.max", "memory.max", "memory.swap.max", "cpu.max"))
CGROUP_COUNTERS = frozenset((
    "pids.current", "pids.events", "memory.current", "memory.peak",
    "memory.events", "cpu.stat", "cgroup.events"))
PAYLOAD_FIELDS = {
    "schema", "attemptId", "trigger", "original", "journalSchema",
    "controllerInstance", "bootId", "principalUid",
    "ownershipObservations", "cgroupObservations", "remainingResources",
    "results", "cleanup"
}


def _id(value: Any, label: str) -> str:
    if type(value) is not str or ID.fullmatch(value) is None:
        raise AdmissionError(f"invalid {label}")
    return value


def _original(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if type(value) is not dict or set(value) != {
            "runRef", "behavior", "cleanup"
    }:
        raise AdmissionError("original result reference is not closed")
    run_ref = value["runRef"]
    if type(run_ref) is not dict or set(run_ref) != {
            "schemaVersion", "runId", "envelopeSha256", "projectionKind"
    }:
        raise AdmissionError("runRef is not closed")
    if (run_ref["schemaVersion"] != "mirrors.evidence-envelope/v1.0"
            or run_ref["projectionKind"] != "private"):
        raise AdmissionError("runRef schema/projection mismatch")
    run_id = _id(run_ref["runId"], "runId")
    envelope = run_ref["envelopeSha256"]
    if type(envelope) is not str or re.fullmatch(r"[0-9a-f]{64}", envelope) is None:
        raise AdmissionError("invalid envelope hash")
    if value["behavior"] not in BEHAVIORS or value["cleanup"] not in CLEANUPS:
        raise AdmissionError("invalid original outcome")
    # Copy every nested field. Later mutation of the caller's linkage object
    # must not rewrite the historical result embedded in the signed receipt.
    return {
        "runRef": {
            "schemaVersion": run_ref["schemaVersion"],
            "runId": run_id,
            "envelopeSha256": envelope,
            "projectionKind": run_ref["projectionKind"],
        },
        "behavior": value["behavior"],
        "cleanup": value["cleanup"],
    }


def _results(values: Any) -> list[dict[str, Any]]:
    if type(values) is not list or len(values) > 4096:
        raise AdmissionError("invalid recovery results")
    checked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in values:
        if type(item) is not dict or set(item) != {
                "resourceId", "sessionId", "kind", "result", "reasonCode"
        }:
            raise AdmissionError("recovery result fields are not closed")
        resource_id = _id(item["resourceId"], "resourceId")
        if resource_id in seen:
            raise AdmissionError("duplicate recovery result")
        seen.add(resource_id)
        result = item["result"]
        if result not in RESULTS:
            raise AdmissionError("invalid recovery result")
        reason = item["reasonCode"]
        if reason is not None:
            reason = _id(reason, "reasonCode")
        checked.append({
            "resourceId": resource_id,
            "sessionId": _id(item["sessionId"], "sessionId"),
            "kind": _id(item["kind"], "kind"),
            "result": result,
            "reasonCode": reason,
        })
    return checked


def _string_map(value: Any, *, exact: frozenset[str] | None = None,
                allowed: frozenset[str] | None = None,
                label: str) -> dict[str, str | None]:
    if type(value) is not dict:
        raise AdmissionError(f"invalid {label}")
    keys = set(value)
    if (exact is not None and keys != exact) or (allowed is not None
                                                  and not keys <= allowed):
        raise AdmissionError(f"invalid {label}")
    if any(item is not None and type(item) is not str for item in value.values()):
        raise AdmissionError(f"invalid {label}")
    return dict(value)


def _cgroup_observations(values: Any,
                         results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if type(values) is not list or len(values) > 4096:
        raise AdmissionError("invalid cgroup observations")
    result_by_id = {item["resourceId"]: item for item in results}
    checked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in values:
        if type(item) is not dict or set(item) != {
                "resourceId", "settings", "counters"
        }:
            raise AdmissionError("cgroup observation is not closed")
        resource_id = _id(item["resourceId"], "cgroup observation resourceId")
        result = result_by_id.get(resource_id)
        if (resource_id in seen or result is None
                or result["kind"] not in CGROUP_KINDS):
            raise AdmissionError("cgroup observation does not resolve uniquely")
        seen.add(resource_id)
        settings = _string_map(item["settings"], exact=CGROUP_SETTINGS,
                               label="cgroup settings")
        counters = _string_map(item["counters"], allowed=CGROUP_COUNTERS,
                               label="cgroup counters")
        if not counters and result["result"] == "reclaimed":
            raise AdmissionError("reclaimed cgroup lacks terminal counters")
        if not counters and result["reasonCode"] is None:
            raise AdmissionError("unobserved cgroup lacks reason code")
        checked.append({"resourceId": resource_id, "settings": settings,
                        "counters": counters})
    expected = {item["resourceId"] for item in results
                if item["kind"] in CGROUP_KINDS}
    if seen != expected:
        raise AdmissionError("cgroup observations do not cover results")
    return checked


def _ids(values: Any, label: str, *, unique: bool = True) -> list[str]:
    if type(values) is not list or len(values) > 4096:
        raise AdmissionError(f"invalid {label}")
    checked = [_id(value, label) for value in values]
    if unique and len(set(checked)) != len(checked):
        raise AdmissionError(f"duplicate {label}")
    return checked


def _artifacts(values: Any) -> list[str]:
    if type(values) is not list or len(values) > 4096:
        raise AdmissionError("invalid public artifact IDs")
    checked = []
    for value in values:
        if type(value) is not str or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
            raise AdmissionError("public artifact ID must be a SHA256 reference")
        checked.append(value)
    if len(set(checked)) != len(checked):
        raise AdmissionError("duplicate public artifact ID")
    return checked


def _cleanup_status(results: list[dict[str, Any]], remaining: list[str]) -> str:
    statuses = {item["result"] for item in results}
    if "failed" in statuses:
        return "failed"
    if (not results or remaining
            or statuses & {"ambiguous", "unconfirmed", "retained"}):
        return "unconfirmed"
    return "confirmed"


def _validate_payload(payload: Any) -> dict[str, Any]:
    if type(payload) is not dict or set(payload) != PAYLOAD_FIELDS:
        raise AdmissionError("invalid recovery receipt")
    if payload["schema"] != SCHEMA:
        raise AdmissionError("invalid recovery receipt schema")
    attempt_id = _id(payload["attemptId"], "attemptId")
    trigger = _id(payload["trigger"], "trigger")
    journal_schema = payload["journalSchema"]
    if journal_schema != "mirrorgate.recovery-journal/v1":
        raise AdmissionError("invalid receipt provenance")
    controller = _id(payload["controllerInstance"], "controllerInstance")
    boot_id = _id(payload["bootId"], "bootId")
    principal_uid = payload["principalUid"]
    if type(principal_uid) is not int or principal_uid < 0:
        raise AdmissionError("invalid receipt provenance")
    original = _original(payload["original"])
    results = _results(payload["results"])
    ownership = _ids(payload["ownershipObservations"], "ownershipObservation",
                     unique=False)
    expected_ownership = [item["result"] for item in results]
    if ownership != expected_ownership:
        raise AdmissionError("ownership observations do not cover results")
    remaining = _ids(payload["remainingResources"], "remainingResource")
    expected_remaining = [item["resourceId"] for item in results
                          if item["result"] in {"ambiguous", "failed", "unconfirmed"}]
    if remaining != expected_remaining:
        raise AdmissionError("remaining resources do not match results")
    cgroups = _cgroup_observations(payload["cgroupObservations"], results)
    cleanup = payload["cleanup"]
    if type(cleanup) is not dict or set(cleanup) != {
            "scope", "requirement", "status", "artifactIds"
    }:
        raise AdmissionError("invalid cleanup projection")
    artifacts = _artifacts(cleanup["artifactIds"])
    derived_status = _cleanup_status(results, remaining)
    if (cleanup["scope"] != "gate-recovery"
            or cleanup["requirement"] != "required"
            or cleanup["status"] != derived_status):
        raise AdmissionError("cleanup projection does not match recovery results")
    return {
        "schema": SCHEMA,
        "attemptId": attempt_id,
        "trigger": trigger,
        "original": original,
        "journalSchema": journal_schema,
        "controllerInstance": controller,
        "bootId": boot_id,
        "principalUid": principal_uid,
        "ownershipObservations": ownership,
        "cgroupObservations": cgroups,
        "remainingResources": remaining,
        "results": results,
        "cleanup": {"scope": "gate-recovery", "requirement": "required",
                    "status": derived_status, "artifactIds": artifacts},
    }


def create_receipt(*, attempt_id: str, trigger: str,
                   original: dict[str, Any] | None,
                   results: list[dict[str, Any]],
                   remaining: list[str] | None = None,
                   ownership_observations: list[str] | None = None,
                   cgroup_observations: list[dict[str, Any]] | None = None,
                   journal_schema: str = "mirrorgate.recovery-journal/v1",
                   controller_instance: str = "unknown",
                   boot_id: str = "unknown", principal_uid: int = 0,
                   artifact_ids: list[str] | None = None) -> dict[str, Any]:
    checked_results = _results(results)
    derived_remaining = [item["resourceId"] for item in checked_results
                         if item["result"] in {"ambiguous", "failed", "unconfirmed"}]
    remaining_values = derived_remaining if remaining is None else list(remaining)
    payload = {
        "schema": SCHEMA,
        "attemptId": attempt_id,
        "trigger": trigger,
        "original": _original(original),
        "journalSchema": journal_schema,
        "controllerInstance": controller_instance,
        "bootId": boot_id,
        "principalUid": principal_uid,
        "ownershipObservations": (
            [item["result"] for item in checked_results]
            if ownership_observations is None else list(ownership_observations)),
        "cgroupObservations": ([] if cgroup_observations is None
                               else list(cgroup_observations)),
        "remainingResources": remaining_values,
        "results": checked_results,
        "cleanup": {
            "scope": "gate-recovery",
            "requirement": "required",
            "status": _cleanup_status(checked_results, remaining_values),
            "artifactIds": ([] if artifact_ids is None else list(artifact_ids)),
        },
    }
    receipt = _validate_payload(payload)
    encoded = json.dumps(receipt, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True).encode()
    if len(encoded) > 512 * 1024:
        raise AdmissionError("recovery receipt exceeds bound")
    receipt["sha256"] = hashlib.sha256(encoded).hexdigest()
    return receipt


def public_summary(receipt: Any) -> dict[str, Any]:
    if type(receipt) is not dict or set(receipt) != PAYLOAD_FIELDS | {"sha256"}:
        raise AdmissionError("invalid recovery receipt")
    payload = {key: value for key, value in receipt.items() if key != "sha256"}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True).encode()
    if len(encoded) > 512 * 1024:
        raise AdmissionError("recovery receipt exceeds bound")
    digest = hashlib.sha256(encoded).hexdigest()
    if type(receipt["sha256"]) is not str or receipt["sha256"] != digest:
        raise AdmissionError("recovery receipt hash mismatch")
    checked = _validate_payload(payload)
    public_cleanup = dict(checked["cleanup"])
    public_cleanup["artifactIds"] = []
    return {
        "schema": PUBLIC_SCHEMA,
        "attemptId": checked["attemptId"],
        "cleanup": public_cleanup,
        "receiptSha256": digest,
    }
