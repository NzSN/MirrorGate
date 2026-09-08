"""Deterministic controller races; physical teardown is covered by acceptance tests."""

import threading
import time
import unittest

from mirrorgate.orchestration import OrchestrationController
import test_orchestration as fixture


class CleanupOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.backend = fixture.FakeBackend()
        self.events = []
        self.controller = OrchestrationController(
            self.backend, connection_id="race-owner", principal_uid=123,
            connection_mode="stdio", emit=self.events.append)
        self.addCleanup(lambda: self.controller.close(join_timeout=1))
        self.request_id = 0
        self.request("hello", {"controlVersions": [1], "requiredCapabilities": []})
        self.session = self.request("session.open", {
            "policyId": "default", "runtime": "node-v1", "manifestJson": fixture.MANIFEST,
            "submission": {"kind": "prebuilt", "input": {"rootId": "root", "relativePath": "."}},
        })["sessionId"]

    def request(self, op, args):
        self.request_id += 1
        response = self.controller.dispatch(fixture.req(self.request_id, op, args))
        self.controller.after_response()
        self.assertTrue(response["ok"], response)
        return response["result"]

    def until(self, predicate):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.005)
        self.fail("controller did not complete the expected transition")

    def expire(self):
        self.backend.on_deadline(self.controller._sessions[self.session].backend_state)

    def test_internal_cleanup_failure_is_retained_when_late_close_joins(self):
        self.backend.cleanup_error = True
        self.expire()
        self.until(lambda: any(item["event"] == "session.closed" for item in self.events))
        self.assertFalse(any(item["event"] == "operation.finished" for item in self.events),
                         "an unaccepted internal operation cannot emit a public completion")
        self.backend.cleanup_error = False
        close = self.request("session.close", {"sessionId": self.session})
        status = self.request("operation.status", {"sessionId": self.session,
                              "operationId": close["operationId"]})
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["error"]["code"], "CLEANUP_FAILED")
        self.assertEqual(len(self.backend.cleaned), 1, "joining cleanup must not retry teardown")
        self.assertEqual(self.request("session.status", {"sessionId": self.session})["phase"],
                         "cleanupFailed")

    def test_explicit_close_joins_an_in_progress_internal_cleanup(self):
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        attempts = []
        original = self.backend.cleanup_session

        def blocked(state, **kwargs):
            attempts.append(state)
            entered.set()
            release.wait(1)
            return original(state, **kwargs)

        self.backend.cleanup_session = blocked
        self.expire()
        self.assertTrue(entered.wait(1))
        first = self.request("session.close", {"sessionId": self.session})
        repeated = self.request("session.cancel", {"sessionId": self.session, "reason": "user-cancel"})
        self.assertEqual(first["operationId"], repeated["operationId"])
        release.set()
        self.until(lambda: any(item["event"] == "operation.finished" for item in self.events))
        self.assertEqual(len(attempts), 1, "internal and explicit close share a teardown owner")
        closed = [item for item in self.events if item["event"] == "session.closed"]
        self.assertEqual(len(closed), 1)

    def test_deferred_completion_cannot_be_overtaken_by_another_session_event(self):
        self.expire()
        self.until(lambda: any(item["event"] == "session.closed" for item in self.events))
        other = self.request("session.open", {
            "policyId": "default", "runtime": "node-v1", "manifestJson": fixture.MANIFEST,
            "submission": {"kind": "prebuilt", "input": {"rootId": "root", "relativePath": "."}},
        })["sessionId"]
        self.request_id += 1
        reply = self.controller.dispatch(fixture.req(
            self.request_id, "session.close", {"sessionId": self.session}))
        self.assertTrue(reply["ok"])
        # The late close joins a completed internal cleanup. Its completion
        # waits for Accepted; a second session's deadline races that handoff.
        deadline_thread = threading.Thread(target=self.backend.on_deadline,
                                           args=(self.controller._sessions[other].backend_state,))
        deadline_thread.start()
        deadline_thread.join(1)
        self.until(lambda: self.controller._sessions[other].phase == "closed")
        self.controller.after_response()
        self.until(lambda: len([item for item in self.events if item["event"] == "session.closed"]) == 2)
        self.assertEqual([item["seq"] for item in self.events], list(range(1, len(self.events) + 1)))

    def test_deadline_during_open_is_observed_after_session_registration(self):
        original = self.backend.open_session

        def expire_before_return(**kwargs):
            state = original(**kwargs)
            kwargs["on_deadline"](state)
            return state

        self.backend.open_session = expire_before_return
        session = self.request("session.open", {
            "policyId": "default", "runtime": "node-v1", "manifestJson": fixture.MANIFEST,
            "submission": {"kind": "prebuilt", "input": {"rootId": "root", "relativePath": "."}},
        })["sessionId"]
        self.until(lambda: any(item["event"] == "session.closed" and item["sessionId"] == session
                               for item in self.events))
        self.assertEqual(self.request("session.status", {"sessionId": session})["phase"], "closed")


if __name__ == "__main__":
    unittest.main()
