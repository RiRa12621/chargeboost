export default {
    branches: ['master'],
    tagFormat: 'v${version}',
    plugins: [
        ['@semantic-release/commit-analyzer', {preset: 'conventionalcommits'}],
        ['@semantic-release/release-notes-generator', {preset: 'conventionalcommits'}],
        './scripts/semantic-release-plugin.mjs',
        ['@semantic-release/github', {
            assets: [
                {path: 'dist/chargeboost@rackow.io.shell-extension.zip', label: 'GNOME Shell extension'},
                {path: 'dist/SHA256SUMS', label: 'SHA-256 checksum'},
            ],
            successCommentCondition: false,
            failCommentCondition: false,
            releasedLabels: false,
        }],
    ],
};
