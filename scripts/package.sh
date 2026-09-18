#!/usr/bin/env bash
# Build the installable extension, without including development/test files.
set -euo pipefail

if (( $# > 2 )); then
    echo "Usage: $0 [OUTPUT_DIRECTORY [vMAJOR.MINOR.PATCH]]" >&2
    exit 2
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:-"$project_dir/dist"}
release_version=${2:-}
stage_dir=$(mktemp -d)
trap 'rm -rf -- "$stage_dir"' EXIT

# Stage an explicit allowlist so new tests, credentials, and build products can
# never accidentally become extension sources. Never mutate checkout metadata.
python3 - "$project_dir" "$stage_dir" "$release_version" <<'PY'
import json
from pathlib import Path
import re
import shutil
import sys

source, stage = map(Path, sys.argv[1:3])
version = sys.argv[3]
metadata = json.loads((source / 'metadata.json').read_text())
if metadata.get('uuid') != 'chargeboost@rackow.io':
    raise SystemExit('Unexpected extension UUID')
if metadata.get('shell-version') != ['50']:
    raise SystemExit('Update the CI Shell matrix when changing supported versions')
for key in ('name', 'description'):
    if not isinstance(metadata.get(key), str) or not metadata[key].strip():
        raise SystemExit(f'Missing metadata field: {key}')
if version:
    version = version.removeprefix('v')
    if len(version) > 16 or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise SystemExit('Release version must be vMAJOR.MINOR.PATCH (max 16 characters without v; no prerelease)')
    # Numeric "version" is assigned by extensions.gnome.org, if published there.
    metadata['version-name'] = version
(stage / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
for name in ('extension.js', 'stylesheet.css'):
    shutil.copyfile(source / name, stage / name)
PY

mkdir -p -- "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)
gnome-extensions pack --force --out-dir "$output_dir" "$stage_dir"

python3 - "$stage_dir" "$output_dir" <<'PY'
import hashlib
from pathlib import Path
import sys
import zipfile

stage, output = map(Path, sys.argv[1:3])
archive = output / 'chargeboost@rackow.io.shell-extension.zip'
expected = {'extension.js', 'metadata.json', 'stylesheet.css'}
with zipfile.ZipFile(archive) as bundle:
    names = bundle.namelist()
    if len(names) != len(expected) or set(names) != expected:
        raise SystemExit(f'Unexpected package contents: {names}')
    for name in expected:
        if bundle.read(name) != (stage / name).read_bytes():
            raise SystemExit(f'Packaged file differs from staged source: {name}')
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / 'SHA256SUMS').write_text(f'{digest}  {archive.name}\n')
print(f'Built and verified {archive}')
PY
