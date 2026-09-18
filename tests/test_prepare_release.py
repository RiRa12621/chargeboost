"""Version the tested artifact without requiring GNOME or touching real builds."""
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import warnings
import zipfile


PROJECT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT / 'scripts/prepare-release.py'
ARCHIVE = 'chargeboost@rackow.io.shell-extension.zip'


class PrepareReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / 'dist'
        self.output.mkdir()
        self.metadata = {
            'uuid': 'chargeboost@rackow.io',
            'shell-version': ['50'],
            'name': 'Charge Boost',
            'description': 'Charge to full once.',
            'version': 7,
            'version-name': '0.1.0',
            'url': 'https://example.org/chargeboost',
            'custom': {'preserve': [True, 42]},
        }
        self.code = b'// Tested code, including non-ASCII: \xc3\xa9\n'
        self.styles = b'/* Tested styles */\n'
        self.make_artifact()

    def make_artifact(self, metadata=None, extra=None, omit=None):
        entries = {
            'extension.js': self.code,
            'stylesheet.css': self.styles,
            'metadata.json': json.dumps(self.metadata if metadata is None else metadata),
        }
        entries.pop(omit, None)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(self.output / ARCHIVE, 'w', zipfile.ZIP_DEFLATED) as bundle:
                for name, contents in entries.items():
                    bundle.writestr(name, contents)
                if extra:
                    bundle.writestr(*extra)
        self.write_checksum()

    def write_checksum(self):
        digest = hashlib.sha256((self.output / ARCHIVE).read_bytes()).hexdigest()
        (self.output / 'SHA256SUMS').write_text(f'{digest}  {ARCHIVE}\n')

    def prepare(self, version='1.2.3', default_directory=False):
        command = ['python3', str(SCRIPT), version]
        if not default_directory:
            command.append(str(self.output))
        return subprocess.run(command, cwd=self.output.parent, capture_output=True,
                              text=True, timeout=10)

    def snapshot(self):
        return {path.name: path.read_bytes() for path in self.output.iterdir()}

    def assert_rejected_without_changes(self, version='1.2.3', message=None):
        original = self.snapshot()
        result = self.prepare(version)
        self.assertNotEqual(result.returncode, 0)
        if message:
            self.assertIn(message, result.stderr)
        self.assertEqual(self.snapshot(), original)

    def test_release_preserves_tested_code_styles_and_unrelated_metadata(self):
        original_sums = (self.output / 'SHA256SUMS').read_bytes()
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.output / ARCHIVE) as bundle:
            self.assertCountEqual(bundle.namelist(),
                                  ['extension.js', 'stylesheet.css', 'metadata.json'])
            self.assertEqual(bundle.read('extension.js'), self.code)
            self.assertEqual(bundle.read('stylesheet.css'), self.styles)
            self.assertEqual(json.loads(bundle.read('metadata.json')),
                             {**self.metadata, 'version-name': '1.2.3'})
        sums = (self.output / 'SHA256SUMS').read_bytes()
        self.assertNotEqual(sums, original_sums)
        digest = hashlib.sha256((self.output / ARCHIVE).read_bytes()).hexdigest()
        self.assertEqual(sums, f'{digest}  {ARCHIVE}\n'.encode())
        self.assertEqual(set(self.snapshot()), {ARCHIVE, 'SHA256SUMS'})

    def test_default_directory_and_optional_v_prefix(self):
        result = self.prepare('v123456789012.3.4', default_directory=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.output / ARCHIVE) as bundle:
            self.assertEqual(json.loads(bundle.read('metadata.json'))['version-name'],
                             '123456789012.3.4')

    def test_invalid_versions_leave_artifacts_unchanged(self):
        for version in ('', '1.2', '01.2.3', '1.2.3-beta', '1.2.3+build',
                        '../1.2.3', '1.2.3\n', 'v-1.2.3', '1234567890123.3.4',
                        '1.2.3; touch unexpected'):
            with self.subTest(version=version):
                self.assert_rejected_without_changes(version, 'Release version must be')

    def test_checksum_mismatch_leaves_artifacts_unchanged(self):
        with (self.output / ARCHIVE).open('ab') as archive:
            archive.write(b'tampered')
        self.assert_rejected_without_changes(message='checksum does not match')

    def test_checksum_format_is_strict(self):
        correct = (self.output / 'SHA256SUMS').read_bytes()
        for invalid in (correct.rstrip(), correct + correct,
                        correct.replace(ARCHIVE.encode(), b'../other.zip'), b''):
            with self.subTest(checksum=invalid):
                (self.output / 'SHA256SUMS').write_bytes(invalid)
                self.assert_rejected_without_changes(message='checksum does not match')

    def test_missing_checksum_leaves_archive_unchanged(self):
        (self.output / 'SHA256SUMS').unlink()
        self.assert_rejected_without_changes(message='SHA256SUMS')

    def test_unexpected_duplicate_and_traversal_members_are_rejected(self):
        for name in ('extension.js', '../extension.js', '/extension.js',
                     'tests/private.js', 'extra.txt'):
            with self.subTest(member=name):
                self.make_artifact(extra=(name, b'unexpected'))
                self.assert_rejected_without_changes(message='Unexpected package contents')

    def test_missing_runtime_file_is_rejected(self):
        self.make_artifact(omit='stylesheet.css')
        self.assert_rejected_without_changes(message='Unexpected package contents')

    def test_symbolic_link_is_rejected_even_with_an_allowed_name(self):
        link = zipfile.ZipInfo('extension.js')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.make_artifact(omit='extension.js', extra=(link, '/tmp/untrusted.js'))
        self.assert_rejected_without_changes(message='not a regular file')

    def test_invalid_metadata_leaves_artifacts_unchanged(self):
        for metadata in ([], {**self.metadata, 'uuid': 'other@example.org'},
                         {**self.metadata, 'shell-version': ['49']},
                         {**self.metadata, 'name': ''},
                         {**self.metadata, 'description': 7}):
            with self.subTest(metadata=metadata):
                self.make_artifact(metadata=metadata)
                self.assert_rejected_without_changes(message='Cannot prepare release:')

    def test_malformed_json_is_rejected(self):
        self.make_artifact(omit='metadata.json', extra=('metadata.json', b'{'))
        self.assert_rejected_without_changes(message='Cannot prepare release:')

    def test_corrupt_zip_is_rejected_even_with_matching_checksum(self):
        (self.output / ARCHIVE).write_bytes(b'not a ZIP')
        self.write_checksum()
        self.assert_rejected_without_changes(message='File is not a zip file')


if __name__ == '__main__':
    unittest.main()
