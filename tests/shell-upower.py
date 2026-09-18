#!/usr/bin/env python3
"""Minimal UPower fixture; can only connect to the runner's private test bus."""
import os
import sys

from gi.repository import Gio, GLib

if os.environ.get("CHARGEBOOST_TEST_BUS") != os.environ.get("DBUS_SYSTEM_BUS_ADDRESS"):
    sys.exit("Refusing to use a non-test system bus")
if not os.environ.get("CHARGEBOOST_TEST_BUS"):
    sys.exit("Missing private test bus")

BUS_NAME = "org.freedesktop.UPower"
ROOT = "/org/freedesktop/UPower"
DEVICE_IFACE = f"{BUS_NAME}.Device"
CONTROL_IFACE = "io.rackow.ChargeBoost.Test"
PATHS = {"battery": f"{ROOT}/devices/battery_TEST", "ac": f"{ROOT}/devices/line_power_TEST"}

root_xml = f"""<node><interface name="{BUS_NAME}">
  <method name="EnumerateDevices"><arg type="ao" direction="out"/></method>
  <method name="GetDisplayDevice"><arg type="o" direction="out"/></method>
  <property name="OnBattery" type="b" access="read"/>
  <property name="DaemonVersion" type="s" access="read"/>
  <property name="LidIsClosed" type="b" access="read"/>
  <property name="LidIsPresent" type="b" access="read"/>
  <signal name="DeviceAdded"><arg type="o"/></signal>
  <signal name="DeviceRemoved"><arg type="o"/></signal>
</interface><interface name="{CONTROL_IFACE}">
  <method name="Update"><arg type="s" direction="in"/><arg type="a{{sv}}" direction="in"/></method>
  <method name="Invalidate"><arg type="s" direction="in"/><arg type="a{{sv}}" direction="in"/></method>
  <method name="GetCalls"><arg type="ab" direction="out"/></method>
</interface></node>"""
types = {
    "Type": "u", "PowerSupply": "b", "IsPresent": "b", "Online": "b",
    "State": "u", "Percentage": "d", "ChargeThresholdSupported": "b",
    "ChargeThresholdEnabled": "b", "ChargeStartThreshold": "u", "ChargeEndThreshold": "u",
    "IconName": "s", "TimeToEmpty": "x", "TimeToFull": "x", "WarningLevel": "u",
}
device_xml = f'<node><interface name="{DEVICE_IFACE}">' + "".join(
    f'<property name="{name}" type="{kind}" access="read"/>' for name, kind in types.items()
) + '<method name="EnableChargeThreshold"><arg type="b" direction="in"/></method></interface></node>'

root = {"OnBattery": GLib.Variant("b", False), "DaemonVersion": GLib.Variant("s", "1.91.4"),
        "LidIsClosed": GLib.Variant("b", False), "LidIsPresent": GLib.Variant("b", True)}
values = {"Type": 2, "PowerSupply": True, "IsPresent": True, "Online": False,
          "State": 5, "Percentage": 83.0, "ChargeThresholdSupported": True,
          "ChargeThresholdEnabled": True, "ChargeStartThreshold": 67, "ChargeEndThreshold": 83,
          "IconName": "battery-full-symbolic", "TimeToEmpty": 0, "TimeToFull": 0, "WarningLevel": 1}
devices = {PATHS["battery"]: {k: GLib.Variant(types[k], v) for k, v in values.items()}}
devices[PATHS["ac"]] = dict(devices[PATHS["battery"]], Type=GLib.Variant("u", 1),
                             Online=GLib.Variant("b", True),
                             ChargeThresholdSupported=GLib.Variant("b", False))
calls = []
connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)


def changed(path, interface, properties):
    connection.emit_signal(None, path, "org.freedesktop.DBus.Properties", "PropertiesChanged",
                           GLib.Variant("(sa{sv}as)", (interface, properties, [])))


def method_call(_connection, _sender, path, interface, method, parameters, invocation):
    if method == "EnumerateDevices":
        invocation.return_value(GLib.Variant("(ao)", (list(devices),)))
    elif method == "GetDisplayDevice":
        invocation.return_value(GLib.Variant("(o)", (PATHS["battery"],)))
    elif interface == CONTROL_IFACE and method == "GetCalls":
        invocation.return_value(GLib.Variant("(ab)", (calls,)))
    elif interface == CONTROL_IFACE and method in ("Update", "Invalidate"):
        name = parameters.get_child_value(0).unpack()
        properties = parameters.get_child_value(1)
        updates = {}
        for i in range(properties.n_children()):
            item = properties.get_child_value(i)
            updates[item.get_child_value(0).unpack()] = item.get_child_value(1).get_variant()
        target = ROOT if name == "root" else PATHS[name]
        (root if name == "root" else devices[target]).update(updates)
        target_interface = BUS_NAME if name == "root" else DEVICE_IFACE
        if method == "Invalidate":
            connection.emit_signal(None, target, "org.freedesktop.DBus.Properties", "PropertiesChanged",
                                   GLib.Variant("(sa{sv}as)", (target_interface, {}, list(updates))))
        else:
            changed(target, target_interface, updates)
        invocation.return_value(None)
    elif interface == DEVICE_IFACE and method == "EnableChargeThreshold":
        enabled, = parameters.unpack()
        calls.append(enabled)
        devices[path]["ChargeThresholdEnabled"] = GLib.Variant("b", enabled)
        changed(path, DEVICE_IFACE, {"ChargeThresholdEnabled": GLib.Variant("b", enabled)})
        invocation.return_value(None)
    else:
        invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)


def get_property(_connection, _sender, path, _interface, name):
    return (root if path == ROOT else devices[path]).get(name)


for interface in Gio.DBusNodeInfo.new_for_xml(root_xml).interfaces:
    connection.register_object(ROOT, interface, method_call, get_property, None)
device_info = Gio.DBusNodeInfo.new_for_xml(device_xml).interfaces[0]
for device_path in devices:
    connection.register_object(device_path, device_info, method_call, get_property, None)
connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                     "RequestName", GLib.Variant("(su)", (BUS_NAME, 0)), None,
                     Gio.DBusCallFlags.NONE, -1, None)
print("READY", flush=True)
GLib.MainLoop().run()
