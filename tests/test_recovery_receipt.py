import hashlib
import json
import unittest
from mirrorgate.policy import AdmissionError
from mirrorgate.recovery_receipt import create_receipt, public_summary


class ReceiptTests(unittest.TestCase):

    def test_recovery_is_separate_and_public_projection_is_allowlisted(self):
        run_ref = {
            "schemaVersion": "mirrors.evidence-envelope/v1.0",
            "runId": "run1",
            "envelopeSha256": "b" * 64,
            "projectionKind": "private"
        }
        original = {
            "runRef": run_ref,
            "behavior": "failed",
            "cleanup": "unconfirmed"
        }
        receipt = create_receipt(attempt_id="a1",
                                 trigger="controller_crash",
                                 original=original,
                                 results=[{
                                     "resourceId": "r1",
                                     "sessionId": "s1",
                                     "kind": "filesystem",
                                     "result": "reclaimed",
                                     "reasonCode": None
                                 }],
                                 artifact_ids=["sha256:" + "a" * 64])
        original["behavior"] = "passed"
        original["runRef"]["runId"] = "mutated"
        self.assertEqual(receipt["original"]["behavior"], "failed")
        self.assertEqual(receipt["original"]["runRef"]["runId"], "run1")
        public = public_summary(receipt)
        encoded = json.dumps(public)
        self.assertNotIn("resourceId", encoded)
        self.assertNotIn("sessionId", encoded)
        self.assertEqual(public["cleanup"]["status"], "confirmed")

    def test_ambiguous_never_projects_confirmed_and_private_fields_reject(
            self):
        receipt = create_receipt(attempt_id="a2",
                                 trigger="startup",
                                 original=None,
                                 results=[{
                                     "resourceId": "r",
                                     "sessionId": "s",
                                     "kind": "process",
                                     "result": "ambiguous",
                                     "reasonCode": "pid_reuse"
                                 }])
        self.assertEqual(
            public_summary(receipt)["cleanup"]["status"], "unconfirmed")
        bad = {
            "resourceId": "r",
            "sessionId": "s",
            "kind": "process",
            "result": "failed",
            "reasonCode": None,
            "pid": 1
        }
        with self.assertRaises(AdmissionError):
            create_receipt(attempt_id="a",
                           trigger="x",
                           original=None,
                           results=[bad])
        empty = create_receipt(attempt_id="empty",
                               trigger="startup",
                               original=None,
                               results=[])
        self.assertEqual(
            public_summary(empty)["cleanup"]["status"], "unconfirmed")
        forged = dict(receipt)
        forged["cleanup"] = dict(receipt["cleanup"], status="confirmed")
        with self.assertRaisesRegex(AdmissionError, "hash mismatch"):
            public_summary(forged)
        with self.assertRaises(AdmissionError):
            create_receipt(attempt_id="x",
                           trigger="startup",
                           original=None,
                           results=[],
                           artifact_ids=["PRIVATE_CANARY"])
        retained = create_receipt(attempt_id="retained",
                                  trigger="startup",
                                  original=None,
                                  results=[{
                                      "resourceId": "r",
                                      "sessionId": "s",
                                      "kind": "retained_source",
                                      "result": "retained",
                                      "reasonCode": None
                                  }])
        self.assertEqual(
            public_summary(retained)["cleanup"]["status"], "unconfirmed")
        forged = dict(empty)
        forged["cleanup"] = dict(empty["cleanup"], status="PRIVATE_CANARY")
        payload = {
            k: v
            for k, v in forged.items() if k != "sha256"
        }
        import hashlib
        forged["sha256"] = hashlib.sha256(
            json.dumps(payload,
                       sort_keys=True,
                       separators=(",", ":"),
                       ensure_ascii=True).encode()).hexdigest()
        with self.assertRaises(AdmissionError):
            public_summary(forged)

    def test_projection_is_rederived_after_a_valid_native_rehash(self):
        receipt = create_receipt(
            attempt_id="projection", trigger="startup", original=None,
            results=[{"resourceId": "r", "sessionId": "s",
                      "kind": "filesystem", "result": "failed",
                      "reasonCode": "removal_failed"}])
        forged = json.loads(json.dumps(receipt))
        forged["cleanup"]["status"] = "confirmed"
        payload = {key: value for key, value in forged.items() if key != "sha256"}
        forged["sha256"] = hashlib.sha256(json.dumps(
            payload, sort_keys=True, separators=(",", ":"),
            ensure_ascii=True).encode()).hexdigest()
        with self.assertRaisesRegex(AdmissionError, "does not match"):
            public_summary(forged)
        forged = json.loads(json.dumps(receipt))
        forged["remainingResources"] = []
        payload = {key: value for key, value in forged.items() if key != "sha256"}
        forged["sha256"] = hashlib.sha256(json.dumps(
            payload, sort_keys=True, separators=(",", ":"),
            ensure_ascii=True).encode()).hexdigest()
        with self.assertRaisesRegex(AdmissionError, "do not match"):
            public_summary(forged)

    def test_cgroup_observation_is_per_resource_and_adapter_compatible(self):
        receipt = create_receipt(
            attempt_id="cgroup", trigger="offline_reclaim", original=None,
            results=[{"resourceId": "cg", "sessionId": "s",
                      "kind": "cgroup", "result": "reclaimed",
                      "reasonCode": None}],
            cgroup_observations=[{
                "resourceId": "cg",
                "settings": {"pids.max": "8", "memory.max": "1048576",
                             "memory.swap.max": None,
                             "cpu.max": "10000 100000"},
                "counters": {"pids.current": "0",
                             "cgroup.events": "populated 0"},
            }])
        self.assertEqual(receipt["cgroupObservations"][0]["resourceId"], "cg")
        self.assertEqual(public_summary(receipt)["cleanup"]["status"],
                         "confirmed")
        with self.assertRaisesRegex(AdmissionError, "do not cover"):
            create_receipt(
                attempt_id="missing", trigger="offline_reclaim", original=None,
                results=[{"resourceId": "cg", "sessionId": "s",
                          "kind": "cgroup", "result": "failed",
                          "reasonCode": "cleanup_failed"}])


if __name__ == "__main__": unittest.main()
