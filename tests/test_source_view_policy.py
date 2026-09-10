"""Frozen parser rules and deterministic selector identity for source views."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate.control_policy import PolicyCatalog, example_rust_policy_document
from mirrorgate.policy import AdmissionError
from mirrorgate.source_view import (MAX_INCLUDE_PATHS, MAX_SELECTOR_BYTES,
                                    SOURCE_VIEW_SCHEMA, SourceViewPolicy,
                                    selector_sha256)

SCHEMA_PATH = ROOT / "protocol/control-v2/policy-schema.json"


def view(workspace_root, include_paths, schema=SOURCE_VIEW_SCHEMA):
    return {"schema": schema, "workspaceRoot": str(workspace_root),
            "includePaths": include_paths}


def catalog_v2(source_root, source_view=None, kinds=("source",)):
    document = example_rust_policy_document(submission_root=source_root)
    document["schema"] = "mirrorgate.control-policy/v2"
    document["agentProfiles"] = []
    policy = document["policies"][0]
    policy["agentProfileIds"] = []
    root = policy["roots"][0]
    root["kinds"] = list(kinds)
    if source_view is not None:
        root["sourceView"] = source_view
    return document


def expected_selector(include_paths):
    canonical = json.dumps({"includePaths": sorted(include_paths)}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(b"mirrorgate.source-view-selector/v1\x00" + canonical).hexdigest()


class SourceViewPolicyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.root = base / "repo"
        self.root.mkdir()
        self.workspace = base / "work"
        self.workspace.mkdir(mode=0o700)

    def tearDown(self):
        self._tmp.cleanup()

    def view(self, include_paths, **overrides):
        value = view(self.workspace, include_paths)
        value.update(overrides)
        return value

    def source_view(self, document):
        catalog = PolicyCatalog.from_document(document)
        return catalog.select("test.rust").roots["submission"].source_view

    def test_v2_root_accepts_source_view_with_selector_identity(self):
        parsed = self.source_view(catalog_v2(self.root, self.view(["package.json", "app"])))
        self.assertIsInstance(parsed, SourceViewPolicy)
        self.assertEqual(parsed.schema, "mirrorgate.source-view/v1")
        info = self.workspace.stat()
        self.assertEqual(parsed.workspace_root, self.workspace)
        self.assertEqual(parsed.workspace_identity, (info.st_dev, info.st_ino))
        self.assertEqual(parsed.include_paths, ("app", "package.json"))
        self.assertEqual(parsed.selector_sha256, expected_selector(["app", "package.json"]))
        self.assertEqual(parsed.selector_sha256, selector_sha256(("app", "package.json")))

    def test_input_order_does_not_change_identity(self):
        first = self.source_view(catalog_v2(self.root, self.view(["src", "app"])))
        second = self.source_view(catalog_v2(self.root, self.view(["app", "src"])))
        self.assertEqual(first.include_paths, ("app", "src"))
        self.assertEqual(first.selector_sha256, second.selector_sha256)

    def test_workspace_root_is_not_part_of_the_selector_digest(self):
        other = Path(self._tmp.name) / "work-2"
        other.mkdir(mode=0o700)
        first = self.source_view(catalog_v2(self.root, self.view(["app"])))
        second = self.source_view(catalog_v2(self.root, view(other, ["app"])))
        self.assertNotEqual(first.workspace_root, second.workspace_root)
        self.assertEqual(first.selector_sha256, second.selector_sha256)

    def test_v2_policy_without_source_view_keeps_none(self):
        self.assertIsNone(self.source_view(catalog_v2(self.root)))

    def test_v1_catalog_rejects_source_view(self):
        document = example_rust_policy_document(submission_root=self.root)
        document["policies"][0]["roots"][0]["kinds"] = ["source"]
        document["policies"][0]["roots"][0]["sourceView"] = self.view(["app"])
        with self.assertRaises(AdmissionError):
            PolicyCatalog.from_document(document)

    def test_source_view_requires_source_only_root(self):
        for kinds in (["prebuilt"], ["source", "prebuilt"], ["prebuilt", "source"]):
            with self.subTest(kinds=kinds), self.assertRaises(AdmissionError):
                PolicyCatalog.from_document(catalog_v2(self.root, self.view(["app"]), kinds=kinds))

    def test_source_view_schema_is_strict(self):
        for invalid in ({"schema": "mirrorgate.source-view/v2",
                         "workspaceRoot": str(self.workspace), "includePaths": ["app"]},
                        {"workspaceRoot": str(self.workspace), "includePaths": ["app"]},
                        {"schema": "mirrorgate.source-view/v1", "includePaths": ["app"]},
                        {"schema": "mirrorgate.source-view/v1", "workspaceRoot": str(self.workspace)},
                        {"schema": "mirrorgate.source-view/v1", "workspaceRoot": str(self.workspace),
                         "includePaths": ["app"], "exclude": []},
                        {"schema": "mirrorgate.source-view/v1", "workspaceRoot": str(self.workspace),
                         "includePaths": ["app"], "workspaceIdentity": [1, 2]},
                        self.view("app"),
                        self.view([]),
                        self.view([1]),
                        self.view([True]),
                        self.view(None),
                        None):
            with self.subTest(invalid=invalid), self.assertRaises(AdmissionError):
                SourceViewPolicy.parse(invalid)

    def test_workspace_root_must_be_an_absolute_existing_private_directory(self):
        missing = Path(self._tmp.name) / "missing"
        document = Path(self._tmp.name) / "document"
        document.write_text("policy\n", encoding="utf-8")
        link = Path(self._tmp.name) / "link"
        link.symlink_to(self.workspace, target_is_directory=True)
        for invalid in ("work", "", ".", "work/../work", str(missing), str(document), str(link),
                        str(self.workspace) + "\0", 1, None, ["/tmp"]):
            with self.subTest(invalid=invalid), self.assertRaises(AdmissionError):
                SourceViewPolicy.parse({"schema": SOURCE_VIEW_SCHEMA,
                                        "workspaceRoot": invalid, "includePaths": ["app"]})

    def test_workspace_root_must_be_owned_by_the_supervisor_with_private_mode(self):
        self.workspace.chmod(0o755)
        with self.assertRaises(AdmissionError):
            SourceViewPolicy.parse(self.view(["app"]))
        self.workspace.chmod(0o700)
        SourceViewPolicy.parse(self.view(["app"]))

        real_uid = os.geteuid()
        with mock.patch("os.geteuid", return_value=real_uid + 1):
            with self.assertRaises(AdmissionError):
                SourceViewPolicy.parse(self.view(["app"]))

    def test_validated_rechecks_the_pinned_workspace_identity(self):
        parsed = self.source_view(catalog_v2(self.root, self.view(["app"])))
        original = Path(self._tmp.name) / "work-original"
        self.workspace.rename(original)
        self.workspace.mkdir(mode=0o700)
        with self.assertRaises(AdmissionError):
            parsed.validated()
        self.workspace.rmdir()
        original.rename(self.workspace)
        parsed.validated()

    def test_include_paths_use_the_canonical_relative_rules(self):
        for invalid in (".", "", "/etc", "../x", "a/../b", "a//b", "a/", "./a", "a/.",
                        "a\0b", "a" * 1025, 1, None):
            with self.subTest(invalid=invalid), self.assertRaises(AdmissionError):
                SourceViewPolicy.parse(self.view([invalid]))

    def test_include_path_count_boundary(self):
        accepted = [f"p{index:04d}" for index in range(MAX_INCLUDE_PATHS)]
        parsed = SourceViewPolicy.parse(self.view(accepted))
        self.assertEqual(len(parsed.include_paths), MAX_INCLUDE_PATHS)
        with self.assertRaises(AdmissionError):
            SourceViewPolicy.parse(self.view(accepted + ["overflow"]))

    def test_selector_byte_boundary(self):
        paths = ["x" * 1021 + f"{index:03d}" for index in range(63)]
        self.assertEqual(sum(len(path.encode("utf-8")) for path in paths), 63 * 1024)
        accepted = paths + ["y" * (MAX_SELECTOR_BYTES - 63 * 1024)]
        self.assertEqual(sum(len(path.encode("utf-8")) for path in accepted), MAX_SELECTOR_BYTES)
        SourceViewPolicy.parse(self.view(accepted))
        rejected = paths + ["y" * (MAX_SELECTOR_BYTES - 63 * 1024 + 1)]
        with self.assertRaises(AdmissionError):
            SourceViewPolicy.parse(self.view(rejected))

    def test_duplicates_and_overlaps_are_rejected(self):
        for invalid in (["app", "app"],
                        ["app", "app/main.js"],
                        ["app/main.js", "app"],
                        ["src", "src-a", "src/b"],
                        ["a/b/c", "a/b"]):
            with self.subTest(invalid=invalid), self.assertRaises(AdmissionError):
                SourceViewPolicy.parse(self.view(invalid))
        for accepted in (["app", "app2"], ["src", "src-a", "srcx/b"], ["a/b", "a-c"]):
            with self.subTest(accepted=accepted):
                SourceViewPolicy.parse(self.view(accepted))

    def test_unicode_paths_keep_scalars_unescaped_in_the_selector(self):
        parsed = SourceViewPolicy.parse(self.view(["目录/文件"]))
        self.assertEqual(parsed.include_paths, ("目录/文件",))
        escaped = json.dumps({"includePaths": ["目录/文件"]}, sort_keys=True,
                             separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        self.assertEqual(parsed.selector_sha256, expected_selector(["目录/文件"]))
        self.assertNotEqual(parsed.selector_sha256,
                            hashlib.sha256(b"mirrorgate.source-view-selector/v1\x00" + escaped).hexdigest())

    def test_validated_rejects_hand_built_policies(self):
        info = self.workspace.stat()
        identity = (info.st_dev, info.st_ino)
        digest = selector_sha256(("app", "src"))
        for invalid in (SourceViewPolicy("mirrorgate.source-view/v1", self.workspace, identity,
                                         ("src", "app"), digest),
                        SourceViewPolicy("mirrorgate.source-view/v1", self.workspace, identity,
                                         ("app", "app"), digest),
                        SourceViewPolicy("mirrorgate.source-view/v1", self.workspace, identity,
                                         ("app",), digest),
                        SourceViewPolicy("mirrorgate.source-view/v1", self.workspace, identity,
                                         ["app", "src"], digest),
                        SourceViewPolicy("mirrorgate.source-view/v2", self.workspace, identity,
                                         ("app", "src"), digest),
                        SourceViewPolicy("mirrorgate.source-view/v1", self.workspace,
                                         (identity[0], identity[1] + 1), ("app", "src"), digest),
                        SourceViewPolicy("mirrorgate.source-view/v1", self.workspace,
                                         identity[0], ("app", "src"), digest),
                        SourceViewPolicy("mirrorgate.source-view/v1", "not-a-path", identity,
                                         ("app", "src"), digest)):
            with self.subTest(invalid=invalid), self.assertRaises(AdmissionError):
                invalid.validated()
        SourceViewPolicy("mirrorgate.source-view/v1", self.workspace, identity,
                         ("app", "src"), digest).validated()

    def test_policy_file_round_trip(self):
        document = catalog_v2(self.root, self.view(["app", "src"]))
        path = Path(self._tmp.name) / "policy.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        catalog = PolicyCatalog.from_file(path)
        parsed = catalog.select("test.rust").roots["submission"].source_view
        self.assertEqual(parsed.include_paths, ("app", "src"))
        self.assertEqual(parsed.workspace_root, self.workspace)
        self.assertEqual(parsed.selector_sha256, expected_selector(["app", "src"]))


class PolicySchemaTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.root = base / "repo"
        self.root.mkdir()
        self.workspace = base / "work"
        self.workspace.mkdir(mode=0o700)
        self.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        self.root_schema = (self.schema["properties"]["policies"]["items"]
                            ["properties"]["roots"]["items"])

    def tearDown(self):
        self._tmp.cleanup()

    def document_root(self, **extra):
        root = {"id": "application-source", "path": str(self.root), "kinds": ["source"],
                "allowedUids": [os.geteuid()]}
        root.update(extra)
        return root

    def source_view(self):
        return {"schema": SOURCE_VIEW_SCHEMA, "workspaceRoot": str(self.workspace),
                "includePaths": ["app", "src"]}

    def test_root_entries_publish_the_optional_source_view_subschema(self):
        self.assertFalse(self.root_schema["additionalProperties"])
        self.assertEqual(self.root_schema["required"],
                         ["id", "path", "kinds", "allowedUids"])
        source_view = self.root_schema["properties"]["sourceView"]
        self.assertEqual(source_view["type"], "object")
        self.assertFalse(source_view["additionalProperties"])
        self.assertEqual(source_view["required"],
                         ["schema", "workspaceRoot", "includePaths"])
        self.assertEqual(source_view["properties"]["schema"]["const"], SOURCE_VIEW_SCHEMA)
        self.assertEqual(source_view["properties"]["workspaceRoot"]["pattern"], "^/")
        include_paths = source_view["properties"]["includePaths"]
        self.assertEqual(include_paths["minItems"], 1)
        self.assertEqual(include_paths["maxItems"], MAX_INCLUDE_PATHS)
        self.assertTrue(include_paths["uniqueItems"])
        self.assertEqual(include_paths["items"]["type"], "string")

    def test_schema_accepts_and_rejects_source_view_documents(self):
        try:
            from jsonschema import Draft202012Validator
        except ImportError:  # pragma: no cover - optional schema extra
            self.skipTest("jsonschema is unavailable")

        validator = Draft202012Validator(self.root_schema)
        validator.validate(self.document_root(sourceView=self.source_view()))
        validator.validate(self.document_root())
        mixed_kind = self.document_root(sourceView=self.source_view(),
                                        kinds=["source", "prebuilt"])
        self.assertTrue(list(validator.iter_errors(mixed_kind)))

        unknown_field = self.document_root(sourceView={**self.source_view(), "exclude": []})
        self.assertTrue(list(validator.iter_errors(unknown_field)))
        unknown_root = self.document_root(sourceView=self.source_view(), ignoreFile=".gitignore")
        self.assertTrue(list(validator.iter_errors(unknown_root)))
        missing_workspace = self.document_root(sourceView={"schema": SOURCE_VIEW_SCHEMA,
                                                           "includePaths": ["app"]})
        self.assertTrue(list(validator.iter_errors(missing_workspace)))
        empty_includes = self.document_root(sourceView={**self.source_view(), "includePaths": []})
        self.assertTrue(list(validator.iter_errors(empty_includes)))


if __name__ == "__main__":
    unittest.main()
