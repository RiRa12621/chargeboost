import {execFileSync} from 'node:child_process';

// CI already tested this archive. Add only the selected version to metadata;
// the helper verifies its checksum and preserves the tested runtime code.
export function prepare(_config, {cwd, nextRelease}) {
    execFileSync('python3', ['scripts/prepare-release.py', nextRelease.version, 'dist'], {
        cwd,
        stdio: 'inherit',
    });
}
