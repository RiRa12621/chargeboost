// Exercise the configured release plugins against real commits. All Git
// operations use disposable local repositories; publishing plugins never run.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {analyzeCommits} from '@semantic-release/commit-analyzer';
import {generateNotes} from '@semantic-release/release-notes-generator';

import releaseConfig from '../release.config.mjs';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const logger = {log() {}, error() {}, warn() {}, success() {}};

function pluginConfig(name) {
    const entry = releaseConfig.plugins.find(plugin =>
        (Array.isArray(plugin) ? plugin[0] : plugin) === name);
    assert.ok(entry, `${name} is configured`);
    return Array.isArray(entry) ? entry[1] : {};
}

const analyzerConfig = pluginConfig('@semantic-release/commit-analyzer');
const notesConfig = pluginConfig('@semantic-release/release-notes-generator');

for (const [message, expected] of [
    ['fix: restore charging threshold on unplug', 'patch'],
    ['fix(upower): handle a disappearing device', 'patch'],
    ['perf: reduce redundant proxy updates', 'patch'],
    ['feat: show active boost in Quick Settings', 'minor'],
    ['feat!: require a newer GNOME Shell', 'major'],
    ['refactor(upower)!: change supported battery behavior', 'major'],
    ['fix: change restore semantics\n\nBREAKING CHANGE: unsupported devices are rejected', 'major'],
    ['docs: clarify installation', null],
    ['test: exercise service restarts', null],
    ['ci: update the Fedora runner', null],
    ['chore: update development dependencies', null],
    ['Update the README', null],
]) {
    test(`release classification: ${message.split('\n')[0]}`, async () => {
        const actual = await analyzeCommits(analyzerConfig, {
            cwd: projectDir,
            commits: [{hash: 'a'.repeat(40), message}],
            logger,
        });
        assert.equal(actual, expected);
    });
}

test('release notes include features, fixes, and breaking changes', async () => {
    const notes = await generateNotes(notesConfig, {
        cwd: projectDir,
        options: {repositoryUrl: 'https://github.com/example/chargeboost.git'},
        lastRelease: {version: '1.2.3', gitTag: 'v1.2.3'},
        nextRelease: {version: '2.0.0', gitTag: 'v2.0.0'},
        commits: [
            {hash: 'a'.repeat(40), message: 'feat: show boost status'},
            {hash: 'b'.repeat(40), message: 'fix: restore on unplug'},
            {hash: 'c'.repeat(40), message: 'feat!: require GNOME Shell 51'},
            {hash: 'd'.repeat(40), message: 'docs: internal contributor guidance'},
        ],
        logger,
    });
    assert.match(notes, /show boost status/);
    assert.match(notes, /restore on unplug/);
    assert.match(notes, /BREAKING CHANGES/);
    assert.match(notes, /require GNOME Shell 51/);
    assert.doesNotMatch(notes, /internal contributor guidance/);
});

test('GitHub release automation does not comment on issues or pull requests', () => {
    const githubConfig = pluginConfig('@semantic-release/github');
    assert.equal(githubConfig.successCommentCondition, false);
    assert.equal(githubConfig.failCommentCondition, false);
    assert.equal(githubConfig.releasedLabels, false);
});

async function previewRelease(t, {previousVersion, messages}) {
    const root = mkdtempSync(join(tmpdir(), 'chargeboost-release-test-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const cwd = join(root, 'checkout');
    const remote = join(root, 'remote.git');
    mkdirSync(cwd);
    // Exclude developer/CI credentials and settings, including commit signing.
    // Restrict Git to file:// so this fixture cannot contact a real remote.
    const env = {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'file',
    };
    const git = (...args) => execFileSync('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git('init', '--bare', '--initial-branch=master', remote);
    git('init', '--initial-branch=master');
    git('config', 'user.name', 'Charge Boost tests');
    git('config', 'user.email', 'chargeboost-tests@example.invalid');
    git('remote', 'add', 'origin', pathToFileURL(remote).href);
    git('commit', '--allow-empty', '-m', 'chore: initial repository');
    if (previousVersion)
        git('tag', `v${previousVersion}`);
    for (const message of messages)
        git('commit', '--allow-empty', '-m', message);
    git('push', '--tags', 'origin', 'master');
    // Match Actions checkout of the exact tested SHA, with detached HEAD.
    git('checkout', '--detach');
    const before = git('ls-remote', 'origin');
    const options = {
        ...releaseConfig,
        repositoryUrl: pathToFileURL(remote).href,
        ci: false,
        dryRun: true,
        // Explicit allowlist excludes prepare/publish/GitHub hooks even if the
        // production release configuration gains additional plugins later.
        plugins: [[
            fileURLToPath(import.meta.resolve('@semantic-release/commit-analyzer')),
            analyzerConfig,
        ]],
    };
    // semantic-release intercepts process stdout. Keep it in a subprocess so
    // interception cannot consume the Node test runner's reporting protocol.
    const script = `
        import {Writable} from 'node:stream';
        const {default: semanticRelease} = await import(process.argv[1]);
        const output = new Writable({write(_chunk, _encoding, callback) { callback(); }});
        const result = await semanticRelease(JSON.parse(process.argv[2]), {
            cwd: process.cwd(), env: process.env, stdout: output, stderr: output,
        });
        output.destroy();
        process.stdout.write(JSON.stringify(result));
    `;
    const result = JSON.parse(execFileSync(process.execPath, [
        '--input-type=module', '--eval', script,
        import.meta.resolve('semantic-release'), JSON.stringify(options),
    ], {cwd, env, encoding: 'utf8', timeout: 30_000}));
    assert.equal(git('ls-remote', 'origin'), before, 'dry run leaves remote refs untouched');
    return result;
}

for (const [name, previousVersion, messages, expected] of [
    ['first eligible release starts at 1.0.0', undefined, ['feat: implement charge boost'], '1.0.0'],
    ['fix increments patch', '1.2.3', ['fix: restore on unplug'], '1.2.4'],
    ['feature increments minor', '1.2.3', ['feat: display boost status'], '1.3.0'],
    ['breaking header increments major', '1.2.3', ['feat!: require GNOME Shell 51'], '2.0.0'],
    ['highest change wins', '1.2.3', [
        'fix: restore on unplug',
        'feat: display boost status',
        'refactor: change supported devices\n\nBREAKING CHANGE: require threshold support',
    ], '2.0.0'],
    ['documentation alone does not release', '1.2.3', ['docs: clarify installation'], null],
    ['ineligible initial commits do not release', undefined, ['ci: add release automation'], null],
]) {
    test(`semantic version: ${name}`, async t => {
        const result = await previewRelease(t, {previousVersion, messages});
        if (expected === null) {
            assert.equal(result, false);
        } else {
            assert.equal(result.nextRelease.version, expected);
            assert.equal(result.nextRelease.gitTag, `v${expected}`);
        }
    });
}
