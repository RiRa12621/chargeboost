# Charge Boost

[![CI](https://github.com/RiRa12621/chargeboost/actions/workflows/ci.yml/badge.svg)](https://github.com/RiRa12621/chargeboost/actions/workflows/ci.yml)****

**Charge to 100% once, then return to your existing battery preservation settings.**

Charge Boost adds a GNOME Shell Quick Settings toggle for temporarily bypassing
UPower's battery charge thresholds. It restores the thresholds when the battery
is full, AC power is disconnected, you cancel, or the extension is disabled.

It uses your existing UPower settings. It never sets its own preservation
percentage or changes your configured start/end thresholds. There are no
preferences, notifications, background daemons, or extra runtime dependencies.

## Requirements

- **GNOME Shell 50**, including Fedora 44 Workstation.
- A laptop battery for which UPower reports `ChargeThresholdSupported=true`.
- **Preserve Battery Health** enabled in GNOME Settings → Power, with AC power
  connected, to start a boost.

The extension uses UPower's D-Bus API and the normal desktop-session permissions.
It does not run privileged commands or write directly to hardware interfaces.

## Get and install

Download `chargeboost@rackow.io.shell-extension.zip` and `SHA256SUMS` from this
repository's [latest GitHub Release](../../releases/latest). If no release has
been published yet, build from source below.

In the directory containing both downloaded files:

```sh
sha256sum --check SHA256SUMS
gnome-extensions install --force ./chargeboost@rackow.io.shell-extension.zip
```

Save your work and log out, then log back in. Enable the extension:

```sh
gnome-extensions enable chargeboost@rackow.io
gnome-extensions info chargeboost@rackow.io
```

You can also enable or disable it in GNOME's **Extensions** app. Installing an
update uses the same steps; a new Shell session is required to load changed code.

### Build from source

Download or clone this repository, open a terminal in its directory, and run:

```sh
./scripts/package.sh
gnome-extensions install --force ./dist/chargeboost@rackow.io.shell-extension.zip
```

Building requires `gnome-extensions`, Bash, and Python 3. The ZIP contains only
the extension's runtime files; tests and development tools are excluded.

## Use

1. Connect AC power and enable **Preserve Battery Health** in GNOME Settings.
2. Open Quick Settings from the top-right system menu.
3. Click **Charge Boost / Charge to Full**.
4. The checked toggle, **Active — click to cancel** subtitle, and panel icon show
   that the boost is active. Click the toggle again to cancel immediately.

When the battery becomes full or you unplug AC, Charge Boost restores the
thresholds automatically. On systems with multiple eligible laptop batteries,
each battery finishes independently. Batteries whose thresholds were already
disabled are left alone. The action is hidden when it cannot be used; an
already-full battery cannot start another boost.

To remove the extension:

```sh
gnome-extensions disable chargeboost@rackow.io
gnome-extensions uninstall chargeboost@rackow.io
```

## Troubleshooting

**No toggle:** check the Shell version, AC connection, and threshold support:

```sh
gnome-shell --version
gnome-extensions info chargeboost@rackow.io
upower -e
```

Use the physical battery path from `upower -e`, for example:

```sh
upower -i /org/freedesktop/UPower/devices/battery_BAT0
```

The aggregate `DisplayDevice` can report thresholds unsupported even when the
physical battery supports them. Charge Boost checks the physical batteries.

**Restore failed:** click the toggle to retry. Errors appear in Shell's log:

```sh
journalctl --user -f -o cat /usr/bin/gnome-shell
```

If Shell crashes, is killed, or UPower cannot restore settings during unload,
re-enable **Preserve Battery Health** in GNOME Settings. UPower does not provide
a temporary threshold lease. The extension attempts restoration before cleanup
but cannot guarantee it when the service or Shell is unavailable.

Threshold writes have a two-second timeout per call and can briefly stall Shell
if UPower is slow. Discovery and monitoring are asynchronous and use signals,
without polling. See [API and lifecycle decisions](docs/API.md).

## Development and testing

The test suite has three layers:

| Layer | What it verifies | Command |
| --- | --- | --- |
| Unit tests | Start/cancel/completion, ownership, errors, multiple batteries, hotplug races, cleanup, and test-driver startup | `node --test tests/*.test.mjs` |
| Package tests | ZIP contents, checksums, release metadata, invalid versions, and unchanged source metadata | `python3 tests/test_package.py` |
| GNOME integration | Real GJS, Quick Settings actors, Gio calls/signals, and extension enable/disable | `./tests/run-shell-tests.sh` |

Unit tests require Node.js 24. Package tests require the build tools listed above.
Integration tests require GNOME Shell 50, GJS, Python 3 with PyGObject, D-Bus,
UPower's GI library, and Mesa software rendering. On Fedora the relevant package
names are `gnome-shell`, `gjs`, `python3-gobject`, `dbus-daemon`, `upower-libs`,
and `mesa-dri-drivers`. These are development tools, not extension dependencies.

The integration runner starts a fresh headless Wayland Shell on private session
and system buses, with temporary settings and an in-memory UPower fixture. It
opens Quick Settings and exercises the actual packaged code in CI. Tests never
contact your real UPower service. Readiness checks have deadlines, all test
processes are cleaned up, and diagnostics go to `test-results/shell/`.
The test profile suppresses GNOME's first-login welcome dialog, and the driver
waits for Shell startup and the overview to finish before opening Quick Settings.
Failures include the timed-out condition or assertion message alongside its stack.

Run all checks locally:

```sh
node --check extension.js
node --test tests/*.test.mjs
python3 tests/test_package.py
./tests/run-shell-tests.sh
```

### Interactive testing on Fedora / Wayland

Following the [GJS testing guide](https://gjs.guide/extensions/development/creating.html#testing-the-extension),
use a fresh nested Shell for each code revision. Install the development build
with the commands above, then, with Fedora's `mutter-devkit` package available:

```sh
dbus-run-session gnome-shell --devkit --wayland
```

Open a terminal **inside the nested session** and run:

```sh
gnome-extensions enable chargeboost@rackow.io
gnome-extensions info chargeboost@rackow.io
```

Watch Shell's output in the launching terminal. A manual nested session uses
your real UPower service; cancel an active boost before closing it. Verify:

- Starting and cancelling changes only `ChargeThresholdEnabled`.
- Unplugging AC restores it and hides the action.
- Reaching full restores it; starting from a preservation-limit “full” state
  does not cancel immediately.
- Disabling the extension during a boost restores it.
- The configured start/end percentages remain unchanged throughout.

Automated simulated-battery tests cannot verify your firmware's charging
behavior, so run these hardware checks before a release. After edits, rebuild
and reinstall, close the nested Shell, and start a new one. Disabling/enabling
alone does not reload cached JavaScript. For the main Wayland session, save your
work and use `gnome-session-quit --logout`, then log back in; `Alt+F2`, `r` does
not restart a Wayland session.

## GitHub Actions and releases

[CI](.github/workflows/ci.yml) runs on branch pushes, pull requests, and manual
dispatch. It checks syntax, runs unit/package tests, builds the ZIP, and tests
the extracted ZIP under GNOME Shell 50 in Fedora 44. It uploads the tested
archive, checksums, and Shell logs as workflow artifacts. Test jobs have read-only
repository permissions and actions are pinned to commit hashes.

To publish a stable release after the repository is on GitHub and the desired
commit is pushed:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Use a new `vMAJOR.MINOR.PATCH` tag for each release. The
[release workflow](.github/workflows/release.yml) runs the same CI on that exact
tagged commit, then publishes the tested ZIP and `SHA256SUMS` as a GitHub Release
with generated release notes. Failed tests or invalid versions block publishing.
The tag supplies the packaged `version-name` (up to 16 characters); source
metadata is not modified.

Only the publishing job has `contents: write`. GitHub's supplied `GITHUB_TOKEN`
is sufficient; no personal token or other repository secret is needed. This
publishes GitHub Releases. Uploads to extensions.gnome.org are not configured.

## License

GPL-2.0-or-later, as declared in [extension.js](extension.js).
