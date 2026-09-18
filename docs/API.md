# UPower integration

Verified using live introspection on GNOME Shell **50.4**, GJS **1.88.1**, and
UPower **1.91.4**, alongside the upstream sources below.

- Like [GNOME Settings](https://raw.githubusercontent.com/GNOME/gnome-control-center/gnome-50/panels/power/cc-power-panel.c),
  enumerate physical batteries (`Type=BATTERY`, `PowerSupply=true`) and call
  `org.freedesktop.UPower.Device.EnableChargeThreshold(boolean)` on their object
  paths. The aggregate `DisplayDevice` reports thresholds unsupported on this
  laptop even though BAT0 supports them.
- `ChargeThresholdSupported` and `ChargeThresholdEnabled` determine eligibility.
  Only the enable/disable method is called; configured threshold percentages
  are never written. See the [UPower Device API](https://upower.freedesktop.org/docs/Device.html).
- Gio proxies initialize asynchronously and subscribe to `PropertiesChanged`
  and device add/remove signals. No polling, timers, subprocesses, or additional
  dependencies are used. Direct Gio proxies also avoid an observed GJS ownership
  problem with devices returned by `UPowerGlib.Client.get_devices_finish()`.
- AC presence comes from line-power devices' `Online` property, also checked
  against `OnBattery`. `OnBattery` alone can lag unplugging while a battery is
  idle. UPowerGlib supplies the named device/state enum values.
- Firmware may report `FULLY_CHARGED` at the preservation limit. If that state
  was already present when starting, completion waits for a transition away
  from it and back, or for 100%. This avoids cancelling immediately at 80%.
- GNOME Shell does not await an asynchronous `disable()`. Threshold mutations
  therefore use synchronous D-Bus calls with a **2-second timeout per call**,
  ensuring ordinary start/cancel/unload operations cannot race an outstanding
  disabling request. This can briefly stall Shell if UPower is slow; discovery
  and monitoring remain asynchronous.
- Ownership is recorded only for an explicit start request against an enabled
  threshold. Even a failed request is rolled back: the
  [UPower handler](https://gitlab.freedesktop.org/upower/upower/-/blob/v1.91.4/src/up-device-battery.c)
  can update its persisted enabled flag before hardware changes fail. A failed
  restoration keeps ownership and displays **Restore failed — click to retry**.
  Unload attempts restoration before disconnecting signals and disposing proxies.

UPower authorizes active desktop sessions through its normal system policy;
the extension does not request privilege escalation. Errors are logged with
`Charge Boost:`. If UPower cannot complete restoration during unload, that
failure is logged. A killed/crashed Shell cannot run cleanup, and UPower has no
temporary threshold lease. In either case, re-enable **Preserve Battery Health**
in GNOME Settings; there is intentionally no persistent recovery daemon.

