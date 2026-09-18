"""Exercise the same packaging command used by CI and GitHub Releases."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile


PROJECT = Path(__file__).resolve().parents[1]
ARCHIVE = 'chargeboost@rackow.io.shell-extension.zip'


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name)
        self.original_metadata = (PROJECT / 'metadata.json').read_bytes()

    def tearDown(self):
        self.assertEqual((PROJECT / 'metadata.json').read_bytes(), self.original_metadata)

    def package(self, version=None):
        command = [str(PROJECT / 'scripts/package.sh'), str(self.output)]
        if version is not None:
            command.append(version)
        return subprocess.run(command, capture_output=True, text=True, timeout=20)

    def test_installable_archive_contains_only_runtime_files_and_valid_checksum(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.output / ARCHIVE
        with zipfile.ZipFile(archive) as bundle:
            self.assertCountEqual(bundle.namelist(), [
                'extension.js', 'metadata.json', 'stylesheet.css',
            ])
            for name in ('extension.js', 'stylesheet.css'):
                self.assertEqual(bundle.read(name), (PROJECT / name).read_bytes())
            self.assertEqual(json.loads(bundle.read('metadata.json')),
                             json.loads(self.original_metadata))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual((self.output / 'SHA256SUMS').read_text(),
                         f'{digest}  {ARCHIVE}\n')

    def test_release_version_is_in_archive_without_changing_source_metadata(self):
        for version in ('v1.2.3', 'v123456789012.3.4'):
            with self.subTest(version=version):
                result = self.package(version)
                self.assertEqual(result.returncode, 0, result.stderr)
                with zipfile.ZipFile(self.output / ARCHIVE) as bundle:
                    metadata = json.loads(bundle.read('metadata.json'))
                expected = json.loads(self.original_metadata)
                expected['version-name'] = version.removeprefix('v')
                self.assertEqual(metadata, expected)

    def test_invalid_release_versions_fail_without_creating_artifacts(self):
        for version in ('v1.2', 'v01.2.3', 'v1.2.3-beta', 'v1.2.3+build',
                        '../v1.2.3', 'v1.2.3\n', 'v-1.2.3', 'v1234567890123.3.4'):
            with self.subTest(version=version):
                result = self.package(version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Release version must be', result.stderr)
                self.assertEqual(list(self.output.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
