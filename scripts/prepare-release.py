#!/usr/bin/env python3
"""Add a release version to the verified CI artifact without rebuilding its code."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import tempfile
import zipfile


ARCHIVE = 'chargeboost@rackow.io.shell-extension.zip'
RUNTIME_FILES = {'extension.js', 'metadata.json', 'stylesheet.css'}


def checksum(contents):
    return f'{hashlib.sha256(contents).hexdigest()}  {ARCHIVE}\n'.encode()


def prepare(version, directory):
    version = version.removeprefix('v')
    if len(version) > 16 or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Release version must be MAJOR.MINOR.PATCH (max 16 characters; no prerelease)')

    archive = directory / ARCHIVE
    sums = directory / 'SHA256SUMS'
    original = archive.read_bytes()
    if sums.read_bytes() != checksum(original):
        raise ValueError('Artifact checksum does not match SHA256SUMS')

    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(original)) as source:
        names = source.namelist()
        if len(names) != len(RUNTIME_FILES) or set(names) != RUNTIME_FILES:
            raise ValueError(f'Unexpected package contents: {names}')
        for entry in source.infolist():
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in (0, stat.S_IFREG):
                raise ValueError(f'Packaged file is not a regular file: {entry.filename}')
        metadata = json.loads(source.read('metadata.json'))
        if not isinstance(metadata, dict) or metadata.get('uuid') != 'chargeboost@rackow.io':
            raise ValueError('Unexpected extension UUID')
        if metadata.get('shell-version') != ['50']:
            raise ValueError('Update the CI Shell matrix when changing supported versions')
        for key in ('name', 'description'):
            if not isinstance(metadata.get(key), str) or not metadata[key].strip():
                raise ValueError(f'Missing metadata field: {key}')
        # Numeric "version" belongs to extensions.gnome.org. Only label the
        # tested archive; its executable code and styles must remain identical.
        metadata['version-name'] = version
        with zipfile.ZipFile(output, 'w') as destination:
            destination.comment = source.comment
            for entry in source.infolist():
                contents = source.read(entry.filename)
                if entry.filename == 'metadata.json':
                    contents = (json.dumps(metadata, indent=2) + '\n').encode()
                destination.writestr(entry, contents)

    updated = output.getvalue()
    # Validate and prepare both files before replacing either. Same-filesystem
    # renames ensure readers never observe a partially written file.
    with tempfile.TemporaryDirectory(prefix='.prepare-release-', dir=directory) as staging:
        staged = Path(staging)
        (staged / ARCHIVE).write_bytes(updated)
        (staged / 'SHA256SUMS').write_bytes(checksum(updated))
        (staged / ARCHIVE).replace(archive)
        (staged / 'SHA256SUMS').replace(sums)
    print(f'Prepared {archive} for v{version}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('artifact_directory', nargs='?', type=Path, default=Path('dist'))
    args = parser.parse_args()
    try:
        prepare(args.version, args.artifact_directory)
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
        parser.exit(1, f'Cannot prepare release: {error}\n')


if __name__ == '__main__':
    main()
