"""A delayed watchdog must not allow a frozen source to commit after expiry."""
import threading
import time
import unittest
from unittest import mock

import test_agent_backend as backend_tests
import test_hosting_controller as controller_tests
from mirrorgate.preparation import BackendError


class SubmissionDeadlineTests(unittest.TestCase):
    setUp = backend_tests.SourceSubmissionTests.setUp
    tearDown = backend_tests.SourceSubmissionTests.tearDown

    def test_expiry_during_freeze_discards_provisional_lease_without_watchdog(self):
        cancel = threading.Event()
        freeze = self.backend._store.freeze
        for deadline_kind in ('host_deadline', 'deadline'):
            with self.subTest(deadline=deadline_kind):
                self.state.sealed = False
                self.state.host_deadline = None
                self.state.deadline = time.monotonic() + 60
                def freezing(*args, **kwargs):
                    lease = freeze(*args, **kwargs)
                    setattr(self.state, deadline_kind, time.monotonic() - 1)
                    return lease
                with mock.patch.object(self.backend._store, 'freeze', side_effect=freezing):
                    with self.assertRaises(BackendError) as raised:
                        self.backend.submit_source(self.state, cancel_event=cancel)
                self.assertEqual(raised.exception.code, 'DEADLINE_EXCEEDED')
                self.assertFalse(cancel.is_set())
                self.assertIsNone(self.state.submission)
                self.assertIsNone(self.state.source_lease)
                self.assertEqual(self.backend.resource_counts(self.state)['snapshots'], 2)


class ControllerDeadlineTests(unittest.TestCase):
    setUp = controller_tests.HostingControllerTests.setUp
    tearDown = controller_tests.HostingControllerTests.tearDown
    request = controller_tests.HostingControllerTests.request
    start = controller_tests.HostingControllerTests.start
    status = controller_tests.HostingControllerTests.status
    until = controller_tests.HostingControllerTests.until

    def test_backend_expiry_preserves_timeout_primary(self):
        controller_tests.FakeHost.mode = 'submit'
        with mock.patch.object(self.backend, 'submit_source', side_effect=
                BackendError('DEADLINE_EXCEEDED', 'authoring', 'expired')):
            self.start()
            self.until(lambda: self.status()['phase'] == 'finished')
        result = self.status()
        self.assertEqual(result['outcome'], 'timedOut')
        self.assertEqual(result['error']['code'], 'DEADLINE_EXCEEDED')
        self.assertEqual(self.backend.submit_count, 0)

    def test_host_budget_starts_when_accepted_before_thread_dispatch(self):
        self.backend.profile.limits = {**self.backend.profile.limits, 'wallMs': 1234}
        before = time.monotonic()
        self.start(after=False)
        state = self.c._sessions[self.session]
        self.assertGreaterEqual(state.backend_state.host_deadline, before + 1.234)
        self.assertLessEqual(state.backend_state.host_deadline, time.monotonic() + 1.234)
        self.assertLessEqual(state.backend_state.host_deadline, state.backend_state.deadline)
        self.c.after_response()
