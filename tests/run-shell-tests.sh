#!/usr/bin/env bash
set -euo pipefail

test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# No activatable desktop services: all test processes use private D-Bus buses.
exec dbus-run-session --config-file "$test_dir/shell-bus.conf" -- \
    python3 "$test_dir/shell-test.py" "$@"
