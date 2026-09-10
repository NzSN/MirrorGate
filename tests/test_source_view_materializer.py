"""Descriptor-pinned materialization rules for filtered source views."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate import source_view as sv
from mirrorgate.artifacts import freeze_tree
from mirrorgate.policy import AdmissionError
from mirrorgate.source_view import (SOURCE_VIEW_SCHEMA, SourceViewCleanupError,
                                    SourceViewPolicy, materialize_source_view,
                                    selector_sha256)

KEEP = "keep.txt"


class MaterializerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.root = base / "repo"
        self.root.mkdir()
        self.workspace = base / "work"
        self.workspace.mkdir(mode=0o700)
        self.destination = self.workspace / "session-test"
        self.scratch = base / "scratch"
        self.scratch.mkdir(mode=0o700)
        (self.workspace / KEEP).write_text("keep", encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, relative, text, mode=0o644):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        path.chmod(mode)
        return path

    def policy(self, *include_paths, workspace=None):
        return SourceViewPolicy.parse({"schema": SOURCE_VIEW_SCHEMA,
                                       "workspaceRoot": str(workspace or self.workspace),
                                       "includePaths": list(include_paths)})

    def materialize(self, policy, *, max_files=4096, max_bytes=8 * 1024 * 1024,
                    source=None, destination=None):
        return materialize_source_view(source or self.root,
                                       destination if destination is not None else self.destination,
                                       policy, max_files=max_files, max_bytes=max_bytes)

    def build_tree(self):
        self.write("app/main.js", "main\n")
        self.write("app/run.sh", "#!/bin/sh\necho run\n", mode=0o755)
        self.write("app/nested/deep.txt", "deep\n")
        self.write("src/lib.js", "lib\n")
        self.write("tests/test.js", "test\n")
        self.write("package.json", "{}\n")
        self.write("tsconfig.json", "{}\n")
        self.write(".mirrors/public/contract.json", "{}\n")
        self.write(".mirrors/private/secret.json", '{"secret":true}\n')
        self.write("omitted/secret.txt", "secret\n")

    def snapshot_parent(self):
        path = self.scratch / "snapshots"
        path.mkdir(exist_ok=True)
        return path

    def assert_no_view(self):
        self.assertFalse(self.destination.exists())
        self.assertEqual(sorted(entry.name for entry in self.workspace.iterdir()), [KEEP])

    def assert_fails(self, policy, **kwargs):
        with self.assertRaises(AdmissionError):
            self.materialize(policy, **kwargs)
        self.assert_no_view()


class MaterializationTests(MaterializerTestCase):
    def test_materializes_only_included_paths_with_private_modes(self):
        self.build_tree()
        result = self.materialize(self.policy("app", "package.json", ".mirrors/public"))
        view = result.path
        self.assertEqual(view, self.destination)
        self.assertEqual(view.parent, self.workspace)
        self.assertEqual(stat.S_IMODE(view.stat().st_mode), 0o700)
        self.assertEqual((view / "app/main.js").read_text(encoding="utf-8"), "main\n")
        self.assertEqual((view / "app/nested/deep.txt").read_text(encoding="utf-8"), "deep\n")
        self.assertEqual((view / "package.json").read_text(encoding="utf-8"), "{}\n")
        self.assertEqual((view / ".mirrors/public/contract.json").read_text(encoding="utf-8"), "{}\n")
        for omitted in ("src", "tests", "tsconfig.json", ".mirrors/private", "omitted"):
            self.assertFalse((view / omitted).exists(), omitted)
        self.assertEqual(stat.S_IMODE((view / "app").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((view / ".mirrors").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((view / "app/main.js").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((view / "app/run.sh").stat().st_mode), 0o700)
        self.assertEqual([entry["path"] for entry in result.manifest],
                         [".mirrors", ".mirrors/public", ".mirrors/public/contract.json",
                          "app", "app/main.js", "app/nested", "app/nested/deep.txt",
                          "app/run.sh", "package.json"])

    def test_manifest_matches_the_snapshot_algorithm(self):
        self.write("a/x.txt", "x\n")
        self.write("a-b/y.txt", "y\n")
        self.write("b.txt", "b\n")
        snapshots = self.scratch / "snapshots"
        snapshots.mkdir()
        for index, include_paths in enumerate((("a",), ("a-b", "a/x.txt"), ("a/x.txt", "a-b"),
                                               ("b.txt", "a/x.txt"), ("a-b/y.txt",))):
            with self.subTest(include_paths=include_paths):
                destination = self.workspace / f"session-manifest-{index}"
                result = self.materialize(self.policy(*include_paths), destination=destination)
                frozen = freeze_tree(result.path, snapshots)
                self.assertEqual(list(result.manifest), list(frozen.manifest))
                self.assertEqual(result.selected_manifest_sha256, frozen.digest)
                encoded = json.dumps(list(result.manifest), sort_keys=True,
                                     separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                self.assertEqual(result.selected_manifest_sha256,
                                 hashlib.sha256(encoded).hexdigest())

    def test_include_file_publishes_created_ancestor_directories(self):
        self.build_tree()
        result = self.materialize(self.policy(".mirrors/public/contract.json"))
        self.assertTrue((result.path / ".mirrors/public/contract.json").is_file())
        self.assertEqual([entry["path"] for entry in result.manifest],
                         [".mirrors", ".mirrors/public", ".mirrors/public/contract.json"])
        frozen = freeze_tree(result.path, self.snapshot_parent())
        self.assertEqual(list(result.manifest), list(frozen.manifest))

    def test_empty_included_directory_is_manifested(self):
        (self.root / "empty").mkdir()
        result = self.materialize(self.policy("empty"))
        self.assertTrue((result.path / "empty").is_dir())
        self.assertEqual(list(result.manifest), [{"path": "empty", "kind": "directory"}])

    def test_unicode_names_are_preserved(self):
        self.write("目录/文件.txt", "内容\n")
        result = self.materialize(self.policy("目录"))
        self.assertEqual((result.path / "目录/文件.txt").read_text(encoding="utf-8"), "内容\n")
        frozen = freeze_tree(result.path, self.snapshot_parent())
        self.assertEqual(list(result.manifest), list(frozen.manifest))
        self.assertEqual(result.selected_manifest_sha256, frozen.digest)

    def test_authoring_mutation_does_not_touch_the_repository(self):
        self.build_tree()
        result = self.materialize(self.policy("app"))
        (result.path / "app/main.js").write_text("changed\n", encoding="utf-8")
        (result.path / "app/added.js").write_text("added\n", encoding="utf-8")
        self.assertEqual((self.root / "app/main.js").read_text(encoding="utf-8"), "main\n")
        self.assertFalse((self.root / "app/added.js").exists())

    def test_workspace_root_inside_the_repository_outside_includes_is_allowed(self):
        self.build_tree()
        workspace = self.root / ".mirrors/work"
        workspace.mkdir(mode=0o700)
        policy = self.policy(".mirrors/public", "app", workspace=workspace)
        destination = workspace / "session-inside"
        result = self.materialize(policy, destination=destination)
        self.assertEqual(result.path, destination)
        self.assertTrue((destination / ".mirrors/public/contract.json").is_file())
        self.assertTrue((destination / "app/main.js").is_file())
        self.assertFalse((destination / ".mirrors/work").exists())
        self.assertFalse((destination / ".mirrors/private").exists())


    def test_sibling_includes_share_one_implicit_ancestor(self):
        self.write("shared/x.txt", "x\n")
        self.write("shared/y.txt", "y\n")
        result = self.materialize(self.policy("shared/y.txt", "shared/x.txt"))
        self.assertEqual((result.path / "shared/x.txt").read_text(), "x\n")
        self.assertEqual((result.path / "shared/y.txt").read_text(), "y\n")
        self.assertEqual([entry["path"] for entry in result.manifest],
                         ["shared", "shared/x.txt", "shared/y.txt"])
        frozen = freeze_tree(result.path, self.snapshot_parent())
        self.assertEqual(result.selected_manifest_sha256, frozen.digest)

    def test_omitted_entries_do_not_consume_view_limits(self):
        self.write("selected.txt", "selected\n")
        for index in range(128):
            self.write(f"omitted-{index:03d}.txt", "omitted\n")
        result = self.materialize(self.policy("selected.txt"), max_files=1,
                                  max_bytes=len("selected\n"))
        self.assertEqual([entry["path"] for entry in result.manifest], ["selected.txt"])


class BoundaryTests(MaterializerTestCase):
    def test_missing_include_path_is_rejected_and_rolled_back(self):
        self.build_tree()
        self.assert_fails(self.policy("missing"))
        self.assert_fails(self.policy("app/nope.txt"))

    def test_symlink_component_is_rejected(self):
        self.build_tree()
        (self.root / "linked").symlink_to(self.root / "app", target_is_directory=True)
        self.assert_fails(self.policy("linked"))
        self.assert_fails(self.policy("linked/main.js"))

    def test_symlink_inside_included_directory_is_rejected(self):
        self.build_tree()
        (self.root / "app/link.js").symlink_to(self.root / "package.json")
        self.assert_fails(self.policy("app"))

    def test_hard_linked_file_is_rejected(self):
        target = self.write("package.json", "{}\n")
        os.link(target, self.root / "hard.json")
        self.assert_fails(self.policy("hard.json"))
        self.assert_fails(self.policy("package.json"))
        os.unlink(self.root / "hard.json")
        result = self.materialize(self.policy("package.json"))
        self.assertEqual((result.path / "package.json").read_text(encoding="utf-8"), "{}\n")

    def test_special_file_is_rejected(self):
        (self.root / "app").mkdir()
        os.mkfifo(self.root / "app/pipe")
        self.assert_fails(self.policy("app"))

    def test_non_utf8_name_is_rejected(self):
        (self.root / "app").mkdir()
        handle = os.open(os.path.join(os.fsencode(self.root / "app"), b"bad-\xff.txt"),
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        os.close(handle)
        self.assert_fails(self.policy("app"))

    def test_file_count_bound(self):
        for index in range(3):
            self.write(f"app/f{index}.txt", "x\n")
        self.assert_fails(self.policy("app"), max_files=3)
        result = self.materialize(self.policy("app"), max_files=4)
        self.assertEqual(len(result.manifest), 4)

    def test_byte_bound(self):
        self.write("app/data.bin", "x" * 100)
        self.assert_fails(self.policy("app"), max_bytes=99)
        result = self.materialize(self.policy("app"), max_bytes=100)
        self.assertEqual((result.path / "app/data.bin").stat().st_size, 100)

    def test_directory_depth_bound(self):
        deep = self.root / "app"
        for index in range(66):
            deep = deep / f"d{index:02d}"
        deep.mkdir(parents=True)
        (deep / "file.txt").write_text("deep\n", encoding="utf-8")
        self.assert_fails(self.policy("app"))
        shallow = self.root / "shallow"
        (shallow / "a" / "b").mkdir(parents=True)
        (shallow / "a" / "b" / "file.txt").write_text("ok\n", encoding="utf-8")
        result = self.materialize(self.policy("shallow"))
        self.assertTrue((result.path / "shallow/a/b/file.txt").is_file())

    def test_path_length_bound(self):
        component = "n" * 200
        deep = self.root / "app" / Path(*([component] * 6))
        deep.mkdir(parents=True)
        (deep / "file.txt").write_text("x\n", encoding="utf-8")
        self.assert_fails(self.policy("app"))
        short = self.root / "short"
        short.mkdir()
        (short / "file.txt").write_text("x\n", encoding="utf-8")
        result = self.materialize(self.policy("short"))
        self.assertTrue((result.path / "short/file.txt").is_file())

    def test_changing_file_is_rejected_and_rolled_back(self):
        path = self.write("app/big.bin", "x" * (2 * 65536))
        original = sv._read
        state = {"mutated": False}

        def mutating_read(fd, size):
            chunk = original(fd, size)
            if chunk and not state["mutated"]:
                state["mutated"] = True
                path.write_text("short\n", encoding="utf-8")
            return chunk

        with mock.patch.object(sv, "_read", mutating_read):
            with self.assertRaises(AdmissionError):
                self.materialize(self.policy("app"))
        self.assertTrue(state["mutated"])
        self.assert_no_view()

    def test_source_root_identity_is_rechecked_and_rolled_back(self):
        self.write("app/data.bin", "x" * (2 * 65536))
        original = sv._read
        state = {"moved": False}

        def moving_read(fd, size):
            chunk = original(fd, size)
            if chunk and not state["moved"]:
                state["moved"] = True
                moved = self.root.parent / "repo-moved"
                self.root.rename(moved)
                replacement = self.root / "app"
                replacement.mkdir(parents=True)
                (replacement / "data.bin").write_text("x" * (2 * 65536), encoding="utf-8")
            return chunk

        with mock.patch.object(sv, "_read", moving_read):
            with self.assertRaises(AdmissionError):
                self.materialize(self.policy("app"))
        self.assertTrue(state["moved"])
        self.assert_no_view()
        result = self.materialize(self.policy("app"))
        self.assertTrue((result.path / "app/data.bin").is_file())

    def test_same_size_overwrite_is_rejected_and_rolled_back(self):
        path = self.write("app/data.bin", "a" * (2 * 65536))
        original = sv._read
        state = {"mutated": False}

        def overwriting_read(fd, size):
            chunk = original(fd, size)
            if chunk and not state["mutated"]:
                state["mutated"] = True
                path.write_text("b" * (2 * 65536), encoding="utf-8")
            return chunk

        with mock.patch.object(sv, "_read", overwriting_read):
            with self.assertRaises(AdmissionError):
                self.materialize(self.policy("app"))
        self.assertTrue(state["mutated"])
        self.assert_no_view()

    def test_rollback_failure_retains_the_exact_path_for_supervisor_retry(self):
        self.write("app/data.txt", "data\n")
        with mock.patch.object(sv, "_read", side_effect=OSError("injected read failure")), \
             mock.patch.object(sv, "remove_snapshot",
                               side_effect=OSError("injected rollback failure")):
            with self.assertRaises(SourceViewCleanupError) as caught:
                self.materialize(self.policy("app"))
        self.assertEqual(caught.exception.path, self.destination)
        self.assertTrue(self.destination.exists())
        sv.remove_snapshot(self.destination)

    def test_destination_replacement_cannot_redirect_later_writes(self):
        self.write("a.txt", "a" * 100)
        self.write("b.txt", "b" * 100)
        outside = self.workspace.parent / "outside"
        outside.mkdir()
        renamed = self.workspace / "renamed-original"
        original = sv._read
        replaced = {"done": False}

        def replace_destination(fd, size):
            chunk = original(fd, size)
            if chunk and not replaced["done"]:
                replaced["done"] = True
                self.destination.rename(renamed)
                self.destination.symlink_to(outside, target_is_directory=True)
            return chunk

        with mock.patch.object(sv, "_read", side_effect=replace_destination):
            with self.assertRaises(AdmissionError):
                self.materialize(self.policy("a.txt", "b.txt"))
        self.assertTrue(replaced["done"])
        self.assertTrue(self.destination.is_symlink())
        self.assertFalse(renamed.exists(), "pinned original destination was not rolled back")
        self.assertEqual(list(outside.iterdir()), [], "writes followed the replacement symlink")

    def test_nested_destination_replacement_cannot_redirect_later_writes(self):
        self.write("app/a.txt", "a" * 100)
        self.write("app/b.txt", "b" * 100)
        outside = self.workspace.parent / "outside-nested"
        outside.mkdir()
        renamed = self.destination / "app-original"
        original = sv._read
        replaced = {"done": False}

        def replace_nested(fd, size):
            chunk = original(fd, size)
            app = self.destination / "app"
            if chunk and app.is_dir() and not replaced["done"]:
                replaced["done"] = True
                app.rename(renamed)
                app.symlink_to(outside, target_is_directory=True)
            return chunk

        with mock.patch.object(sv, "_read", side_effect=replace_nested):
            with self.assertRaises(AdmissionError):
                self.materialize(self.policy("app"))
        self.assertTrue(replaced["done"])
        self.assertFalse((outside / "b.txt").exists())
        self.assertFalse(self.destination.exists())

    def test_destination_directory_mode_change_is_rejected(self):
        self.write("app/a.txt", "a" * 100)
        self.write("app/b.txt", "b" * 100)
        original = sv._read
        changed = {"done": False}

        def change_modes(fd, size):
            chunk = original(fd, size)
            nested = self.destination / "app"
            if chunk and nested.is_dir() and not changed["done"]:
                changed["done"] = True
                self.destination.chmod(0o755)
                nested.chmod(0o755)
            return chunk

        with mock.patch.object(sv, "_read", side_effect=change_modes):
            with self.assertRaises(AdmissionError):
                self.materialize(self.policy("app"))
        self.assertTrue(changed["done"])
        self.assert_no_view()

    def test_failed_destination_directory_creation_closes_source_descriptor(self):
        self.write("app/data.txt", "data\n")
        before = set(os.listdir("/proc/self/fd"))
        with mock.patch.object(sv, "_ensure_directory",
                               side_effect=AdmissionError("injected destination failure")):
            with self.assertRaises(AdmissionError):
                self.materialize(self.policy("app/data.txt"))
        self.assertEqual(set(os.listdir("/proc/self/fd")), before)
        self.assert_no_view()

    def test_destination_collision_is_rejected_without_removing_other_entries(self):
        self.build_tree()
        self.destination.mkdir()
        (self.destination / "existing.txt").write_text("mine", encoding="utf-8")
        with self.assertRaises(AdmissionError):
            self.materialize(self.policy("app"))
        self.assertEqual((self.destination / "existing.txt").read_text(encoding="utf-8"), "mine")
        self.assertTrue((self.workspace / KEEP).exists())

    def test_second_materialization_into_the_same_destination_is_rejected(self):
        self.build_tree()
        first = self.materialize(self.policy("app"))
        (first.path / "app/added.js").write_text("added\n", encoding="utf-8")
        with self.assertRaises(AdmissionError):
            self.materialize(self.policy("app"))
        self.assertEqual((first.path / "app/added.js").read_text(encoding="utf-8"), "added\n")

    def test_destination_must_be_a_direct_child_of_the_approved_workspace(self):
        self.build_tree()
        outside = self.root / "views"
        outside.mkdir()
        for destination in (outside / "session-outside",
                            self.workspace / "nested" / "session-nested",
                            Path("relative-session")):
            with self.subTest(destination=destination):
                with self.assertRaises(AdmissionError):
                    self.materialize(self.policy("app"), destination=destination)
        self.assertEqual(sorted(entry.name for entry in self.workspace.iterdir()), [KEEP])
        self.assertEqual(sorted(entry.name for entry in outside.iterdir()), [])

    def test_selected_path_must_not_contain_the_workspace_root(self):
        self.build_tree()
        workspace = self.root / "app/work"
        workspace.mkdir(mode=0o700)
        policy = self.policy("app", workspace=workspace)
        with self.assertRaises(AdmissionError):
            self.materialize(policy, destination=workspace / "session-inside")
        self.assertEqual(sorted(entry.name for entry in workspace.iterdir()), [])

    def test_selected_path_must_not_be_inside_the_workspace_root(self):
        workspace = self.root / "work"
        selected = workspace / "prior"
        selected.mkdir(parents=True)
        (selected / "source.txt").write_text("prior\n")
        workspace.chmod(0o700)
        policy = self.policy("work/prior", workspace=workspace)
        with self.assertRaises(AdmissionError):
            self.materialize(policy, destination=workspace / "session-new")
        self.assertFalse((workspace / "session-new").exists())

    def test_source_root_must_not_be_inside_the_workspace_root(self):
        source = self.workspace / "prior-source"
        source.mkdir()
        (source / "app.txt").write_text("source\n")
        policy = self.policy("app.txt")
        with self.assertRaises(AdmissionError):
            materialize_source_view(source, self.destination, policy,
                                    max_files=64, max_bytes=1024)
        self.assertFalse(self.destination.exists())

    def test_workspace_identity_is_rechecked_before_publish(self):
        self.build_tree()
        policy = self.policy("app")
        original = self.workspace.parent / "work-original"
        self.workspace.rename(original)
        self.workspace.mkdir(mode=0o700)
        with self.assertRaises(AdmissionError):
            self.materialize(policy)
        self.assertEqual(sorted(entry.name for entry in self.workspace.iterdir()), [])

    def test_invalid_policy_objects_are_rejected(self):
        self.build_tree()
        info = self.workspace.stat()
        identity = (info.st_dev, info.st_ino)
        for invalid in (SourceViewPolicy(SOURCE_VIEW_SCHEMA, self.workspace, identity,
                                         ("src", "app"), selector_sha256(("app", "src"))),
                        SourceViewPolicy(SOURCE_VIEW_SCHEMA, self.workspace, identity,
                                         ("app",), "0" * 64),
                        SourceViewPolicy("mirrorgate.source-view/v2", self.workspace, identity,
                                         ("app",), selector_sha256(("app",))),
                        SourceViewPolicy(SOURCE_VIEW_SCHEMA, self.workspace,
                                         (identity[0], identity[1] + 1), ("app",),
                                         selector_sha256(("app",))),
                        {"schema": SOURCE_VIEW_SCHEMA, "workspaceRoot": str(self.workspace),
                         "includePaths": ["app"]}):
            with self.subTest(invalid=invalid):
                with self.assertRaises(AdmissionError):
                    materialize_source_view(self.root, self.destination, invalid,
                                            max_files=64, max_bytes=1024)
        self.assert_no_view()

    def test_limit_arguments_must_be_positive_integers(self):
        self.build_tree()
        policy = self.policy("app")
        for name in ("max_files", "max_bytes"):
            for value in (0, -1, True, 2**61):
                with self.subTest(name=name, value=value), self.assertRaises(AdmissionError):
                    self.materialize(policy, **{name: value})
        self.assert_no_view()


if __name__ == "__main__":
    unittest.main()
