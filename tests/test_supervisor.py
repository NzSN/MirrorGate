import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from mirrorgate import AdmissionError, Limits, RuntimeMount, ToolRequest, TrustedConfig, freeze_tree
from mirrorgate.artifacts import remove_snapshot


class PolicyTests(unittest.TestCase):
    def test_tool_request_cannot_change_policy(self):
        for key in ("profile", "workspace", "environment", "mounts", "network", "backend", "limits"):
            with self.subTest(key=key), self.assertRaises(AdmissionError):
                ToolRequest.from_dict({"argv": ["true"], key: "host"})

    def test_hostile_cwd_and_arguments(self):
        for cwd in ("/", "../private", "a/../b", "a//b", "./a", "", "a\0b"):
            with self.subTest(cwd=cwd), self.assertRaises(AdmissionError):
                ToolRequest(("true",), cwd).validate()
        for argv in ([], ["true\0x"], [42], ["x" * 65537]):
            with self.subTest(argv=repr(argv)[:40]), self.assertRaises(AdmissionError):
                ToolRequest(argv).validate()
        self.assertEqual(ToolRequest.from_dict({"argv": ["/usr/bin/true"]}).argv, ("/usr/bin/true",))

    def test_unsupported_limits_fail_admission(self):
        for field in ("aggregate_memory_bytes", "aggregate_cpu_seconds", "aggregate_processes", "aggregate_disk_bytes"):
            with self.subTest(field=field), self.assertRaises(AdmissionError):
                Limits(**{field: 100}).validate()
        for value in (float("inf"), float("nan"), 0, -1, True):
            with self.subTest(value=value), self.assertRaises(AdmissionError):
                Limits(wall_seconds=value).validate()

    def test_runtime_mount_destination_and_broad_roots(self):
        for mount in (RuntimeMount("/", "/runtime/host"), RuntimeMount("/home", "/runtime/home"), RuntimeMount("/usr", "/etc"), RuntimeMount("/usr", "/runtime/x/../etc")):
            with self.subTest(mount=mount), self.assertRaises(AdmissionError):
                mount.checked()

    def test_profile_admission_and_source_output_separation(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source"
            source.mkdir()
            output = Path(tmp) / "output"
            output.mkdir()
            for config in (TrustedConfig("host", source), TrustedConfig("execution", source, network="host"), TrustedConfig("execution", source, output=output), TrustedConfig("build", source, output=source), TrustedConfig("execution", source, backend="plain-process")):
                with self.subTest(config=config), self.assertRaises(AdmissionError):
                    config.checked()
            self.assertEqual(TrustedConfig("build", source, output=output).checked().output, output)
            (output / "old").write_text("old")
            with self.assertRaises(AdmissionError):
                TrustedConfig("build", source, output=output).checked()

    def test_build_output_cannot_overlap_runtime_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            runtime = root / "runtime"
            child = runtime / "child"
            source.mkdir()
            child.mkdir(parents=True)
            for runtime_root, output in ((runtime, runtime), (runtime, child), (child, runtime)):
                with self.subTest(runtime=runtime_root, output=output), self.assertRaisesRegex(AdmissionError, "runtime and build output roots must not overlap"):
                    TrustedConfig("build", source, output=output, runtime_mounts=(RuntimeMount("/usr", "/usr"), RuntimeMount(runtime_root, "/runtime/tools"))).checked()

    def test_pinned_output_cannot_alias_runtime_after_path_admission(self):
        from mirrorgate import GateSession
        from mirrorgate.artifacts import _open_directory
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, runtime, output = (root / name for name in ("source", "runtime", "output"))
            for directory in (source, runtime, output):
                directory.mkdir()
            def aliased_open(path):
                # Simulate a distinct operator mount spelling of the same inode.
                return _open_directory(runtime if path == output else path)
            config = TrustedConfig("build", source, output=output, runtime_mounts=(RuntimeMount("/usr", "/usr"), RuntimeMount(runtime, "/runtime/tools")))
            with mock.patch("mirrorgate.sandbox._open_directory", side_effect=aliased_open), self.assertRaisesRegex(AdmissionError, "aliases an approved runtime"):
                GateSession(config)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.owned = self.root / "owned"
        self.source.mkdir()
        self.owned.mkdir()

    def tearDown(self):
        remove_snapshot(self.owned)
        self.temp.cleanup()

    def test_snapshot_independent_identity_and_executable_mode(self):
        original = self.source / "worker"
        original.write_bytes(b"first")
        original.chmod(0o755)
        first = freeze_tree(self.source, self.owned)
        second = freeze_tree(self.source, self.owned)
        self.assertEqual(first.digest, second.digest)
        original.write_bytes(b"changed")
        self.assertEqual((first.path / "worker").read_bytes(), b"first")
        self.assertEqual((first.path / "worker").stat().st_mode & 0o777, 0o500)
        third = freeze_tree(self.source, self.owned)
        self.assertNotEqual(first.digest, third.digest)

    def test_rejects_symlink_and_symlink_ancestor(self):
        (self.source / "link").symlink_to("/etc/passwd")
        with self.assertRaises(AdmissionError):
            freeze_tree(self.source, self.owned)
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(AdmissionError):
            freeze_tree(alias, self.owned)
        self.assertEqual(list(self.owned.iterdir()), [])

    def test_rejects_hardlinks_and_special_files(self):
        private = self.root / "private"
        private.write_text("sentinel")
        os.link(private, self.source / "hardlink")
        with self.assertRaises(AdmissionError):
            freeze_tree(self.source, self.owned)
        (self.source / "hardlink").unlink()
        os.mkfifo(self.source / "fifo")
        with self.assertRaises(AdmissionError):
            freeze_tree(self.source, self.owned)

    def test_rejects_parent_traversal_and_recursive_destination(self):
        with self.assertRaises(AdmissionError):
            freeze_tree(self.source / ".." / "source", self.owned)
        nested = self.source / "nested"
        nested.mkdir()
        with self.assertRaises(AdmissionError):
            freeze_tree(self.source, nested)

    def test_snapshot_size_and_entry_caps(self):
        (self.source / "large").write_bytes(b"123456")
        with self.assertRaises(AdmissionError):
            freeze_tree(self.source, self.owned, max_bytes=5)
        (self.source / "other").write_bytes(b"1")
        with self.assertRaises(AdmissionError):
            freeze_tree(self.source, self.owned, max_files=1)

    def test_detects_file_mutation_during_read(self):
        source = self.source / "file"
        source.write_bytes(b"before")
        real_read = os.read
        mutated = False
        def hostile_read(fd, count):
            nonlocal mutated
            data = real_read(fd, count)
            if not mutated:
                mutated = True
                source.write_bytes(b"after!")
            return data
        with mock.patch("mirrorgate.artifacts.os.read", side_effect=hostile_read), self.assertRaises(AdmissionError):
            freeze_tree(self.source, self.owned)
        self.assertEqual(list(self.owned.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
