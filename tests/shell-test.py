#!/usr/bin/env python3
"""Run the production extension in a fresh headless GNOME Shell and private buses."""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parent.parent
EXTENSION_SOURCE = Path(os.environ.get("CHARGEBOOST_EXTENSION_DIR", PROJECT)).resolve()
LOGS = Path(sys.argv[1] if len(sys.argv) > 1 else PROJECT / "test-results/shell").resolve()
LOGS.mkdir(parents=True, exist_ok=True)
(LOGS / "result.json").unlink(missing_ok=True)


def ready_line(process, expected=None):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(10):
            raise RuntimeError("Timed out starting test D-Bus fixture")
        line = process.stdout.readline().strip()
        if not line or (expected and line != expected):
            raise RuntimeError(f"Unexpected fixture readiness: {line!r}")
        return line


def run():
    processes = []
    with tempfile.TemporaryDirectory(prefix="chargeboost-shell-") as temporary:
        temporary = Path(temporary)
        env = os.environ.copy()
        for key in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"):
            directory = temporary / key.lower()
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        env.update(GSETTINGS_BACKEND="keyfile", LIBGL_ALWAYS_SOFTWARE="1", NO_AT_BRIDGE="1",
                   XDG_SESSION_TYPE="wayland", LC_ALL="C.UTF-8",
                   CHARGEBOOST_TEST_RESULT=str(temporary / "result.json"))
        # Never connect the test compositor to the user's display or system bus.
        for key in ("DISPLAY", "WAYLAND_DISPLAY", "GNOME_SETUP_DISPLAY"):
            env.pop(key, None)
        extensions = Path(env["XDG_DATA_HOME"]) / "gnome-shell/extensions"
        extension = extensions / "chargeboost@rackow.io"
        extension.mkdir(parents=True)
        for name in ("extension.js", "metadata.json", "stylesheet.css"):
            shutil.copyfile(EXTENSION_SOURCE / name, extension / name)
        driver = extensions / "chargeboost-tests@rackow.io"
        driver.mkdir()
        shutil.copyfile(PROJECT / "tests/shell-driver.js", driver / "extension.js")
        (driver / "metadata.json").write_text(json.dumps({
            "uuid": driver.name, "name": "Charge Boost test driver", "description": "Isolated tests",
            "shell-version": ["50"],
        }))
        result_path = Path(env["CHARGEBOOST_TEST_RESULT"])
        try:
            with (LOGS / "bus.log").open("w") as bus_log, (LOGS / "upower.log").open("w") as power_log, \
                    (LOGS / "shell.log").open("w") as shell_log:
                bus = subprocess.Popen(["dbus-daemon", "--nofork", "--print-address=1",
                                        f"--config-file={PROJECT / 'tests/shell-bus.conf'}"],
                                       stdout=subprocess.PIPE, stderr=bus_log, text=True)
                processes.append(bus)
                env["DBUS_SYSTEM_BUS_ADDRESS"] = ready_line(bus)
                env["CHARGEBOOST_TEST_BUS"] = env["DBUS_SYSTEM_BUS_ADDRESS"]
                fixture = subprocess.Popen([sys.executable, str(PROJECT / "tests/shell-upower.py")],
                                           env=env, stdout=subprocess.PIPE, stderr=power_log, text=True)
                processes.append(fixture)
                ready_line(fixture, "READY")
                subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions",
                                "['chargeboost@rackow.io', 'chargeboost-tests@rackow.io']"], env=env, check=True)
                subprocess.run(["gsettings", "set", "org.gnome.shell", "disable-user-extensions", "false"],
                               env=env, check=True)
                # A fresh profile otherwise opens the welcome dialog after
                # startup, which closes Quick Settings as a system modal.
                subprocess.run(["gsettings", "set", "org.gnome.shell", "welcome-dialog-last-shown-version", "50"],
                               env=env, check=True)
                shell = subprocess.Popen(["gnome-shell", "--headless", "--wayland", "--no-x11",
                                          "--virtual-monitor", "1280x720"], env=env,
                                         stdout=shell_log, stderr=subprocess.STDOUT)
                processes.append(shell)
                deadline = time.monotonic() + 60
                while not result_path.exists():
                    if shell.poll() is not None:
                        raise RuntimeError(f"GNOME Shell exited with status {shell.returncode}")
                    if fixture.poll() is not None:
                        raise RuntimeError("UPower fixture exited unexpectedly")
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Timed out waiting for GNOME Shell test results")
                    time.sleep(0.1)
                result = json.loads(result_path.read_text())
                (LOGS / "result.json").write_text(json.dumps(result, indent=2) + "\n")
                if not result["ok"]:
                    raise RuntimeError(result["error"])
                for name in result["tests"]:
                    print(f"PASS: {name}")
                print(f"{len(result['tests'])} real GNOME Shell integration checks passed")
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    diagnostics = (LOGS / "shell.log").read_text()
    if "Charge Boost:" in diagnostics or "chargeboost@rackow.io/extension.js:" in diagnostics:
        raise RuntimeError("Extension errors were logged; see shell.log")
    print(f"Logs: {LOGS}")


try:
    run()
except Exception as error:
    print(f"FAIL: {error}\nLogs: {LOGS}", file=sys.stderr)
    for name in ("shell.log", "upower.log"):
        path = LOGS / name
        if path.exists():
            print(f"--- {name} ---\n{path.read_text()[-12000:]}", file=sys.stderr)
    sys.exit(1)
