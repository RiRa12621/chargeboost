/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import UPower from 'gi://UPowerGlib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BUS_NAME = 'org.freedesktop.UPower';
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices"><arg type="ao" direction="out"/></method>
    <property name="OnBattery" type="b" access="read"/>
    <signal name="DeviceAdded"><arg type="o"/></signal>
    <signal name="DeviceRemoved"><arg type="o"/></signal>
</interface></node>`);
const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="Online" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="ChargeThresholdSupported" type="b" access="read"/>
    <property name="ChargeThresholdEnabled" type="b" access="read"/>
</interface></node>`);
const PROXY_FLAGS = Gio.DBusProxyFlags.DO_NOT_AUTO_START |
    Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES;

const ChargeBoostIndicator = GObject.registerClass(
class ChargeBoostIndicator extends SystemIndicator {
    constructor() {
        super();

        this._closed = false;
        this._devices = new Map();
        this._boosted = new Map();
        this._clientSignals = [];
        this._cancellable = new Gio.Cancellable();
        this._error = null;

        this._indicator = this._addIndicator();
        this._indicator.iconName = 'battery-full-charging-symbolic';
        this._indicator.visible = false;

        this._toggle = new QuickToggle({
            title: _('Charge Boost'),
            subtitle: _('Charge to Full'),
            iconName: 'battery-full-charging-symbolic',
            // Only show checked after the UPower operation, not on button press.
            toggleMode: false,
            visible: false,
        });
        this._toggle.connect('clicked', () => {
            this._error = null;
            if (this._boosted.size > 0)
                this._restoreAll();
            else
                this._start();
            this._sync();
        });
        this.quickSettingsItems.push(this._toggle);
        this._initUPower().catch(error => this._reportError(error));
    }

    async _initUPower() {
        const client = await UPowerProxy.newAsync(Gio.DBus.system, BUS_NAME,
            '/org/freedesktop/UPower', this._cancellable, PROXY_FLAGS);
        if (this._closed) {
            client.run_dispose();
            return;
        }
        this._client = client;
        this._clientSignals = [
            client.connect('g-properties-changed', () => this._sync()),
            client.connect('notify::g-name-owner', () => this._sync()),
            client.connect('g-signal', (_client, _sender, name, parameters) => {
                const [path] = parameters.deepUnpack();
                if (name === 'DeviceAdded') {
                    this._addDevice(path).catch(error => this._reportError(error));
                } else if (name === 'DeviceRemoved') {
                    this._removeDevice(path);
                    this._sync();
                }
            }),
        ];
        const [paths] = await client.EnumerateDevicesAsync(this._cancellable);
        if (!this._closed)
            await Promise.all(paths.map(path => this._addDevice(path)));
    }

    _reportError(error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.error(`Charge Boost: ${error.message}`);
    }

    async _addDevice(path) {
        if (this._devices.has(path))
            return;
        const entry = {device: null, signal: null};
        this._devices.set(path, entry);
        let device;
        try {
            device = await DeviceProxy.newAsync(Gio.DBus.system, BUS_NAME,
                path, this._cancellable, PROXY_FLAGS);
        } catch (error) {
            if (this._devices.get(path) === entry)
                this._devices.delete(path);
            throw error;
        }
        if (this._closed || this._devices.get(path) !== entry) {
            device.run_dispose();
            return;
        }
        entry.device = device;
        entry.signal = device.connect('g-properties-changed', () => this._sync());
        // A removed battery may return after a failed restoration.
        if (this._boosted.has(path)) {
            this._boosted.get(path).device = device;
            this._restore(path);
        }
        this._sync();
    }

    _removeDevice(path) {
        const entry = this._devices.get(path);
        if (entry?.device) {
            entry.device.disconnect(entry.signal);
            entry.device.run_dispose();
        }
        this._devices.delete(path);
    }

    _onAC() {
        return Boolean(this._client?.g_name_owner) && this._client.OnBattery === false &&
            [...this._devices.values()].some(({device}) =>
                device?.Type === UPower.DeviceKind.LINE_POWER && device.Online);
    }

    _candidates() {
        return [...this._devices.values()].map(({device}) => device).filter(device =>
            device?.Type === UPower.DeviceKind.BATTERY && device.g_name_owner && device.PowerSupply &&
            device.IsPresent && device.ChargeThresholdSupported && device.ChargeThresholdEnabled);
    }

    _setThreshold(path, enabled) {
        // Shell does not await disable(). Keep mutations ordered and completed
        // before teardown, with a bounded wait (also how GNOME Settings calls it).
        // Discovery and all monitoring remain asynchronous, without polling.
        Gio.DBus.system.call_sync(
            BUS_NAME, path, 'org.freedesktop.UPower.Device',
            'EnableChargeThreshold', new GLib.Variant('(b)', [enabled]),
            null, Gio.DBusCallFlags.NONE, 2000, null);
    }

    _start() {
        if (!this._onAC())
            return;
        for (const device of this._candidates()) {
            if (device.Percentage >= 100)
                continue;
            const path = device.get_object_path();
            // A failed call can already have changed UPower's persisted state.
            // Take responsibility only after an explicit click, on enabled limits.
            this._boosted.set(path, {
                device,
                sawDisabled: false,
                ignoreInitialFull: device.State === UPower.DeviceState.FULLY_CHARGED,
                restoreFailed: false,
            });
            try {
                this._setThreshold(path, false);
            } catch (error) {
                this._reportError(error);
                this._error = _('Could not start — try again');
                this._restoreAll();
                break;
            }
        }
    }

    _restore(path) {
        try {
            this._setThreshold(path, true);
            this._boosted.delete(path);
        } catch (error) {
            this._reportError(error);
            // Retain ownership and a visible manual retry; avoid retrying on
            // every unrelated property notification if UPower rejects the call.
            this._boosted.get(path).restoreFailed = true;
        }
    }

    _restoreAll() {
        for (const path of this._boosted.keys())
            this._restore(path);
    }

    _sync() {
        if (this._closed)
            return;
        const onAC = this._onAC();
        for (const [path, boost] of this._boosted) {
            if (!this._devices.get(path)?.device) {
                if (!boost.restoreFailed)
                    this._restore(path);
                continue;
            }
            const {device} = boost;
            if (device.ChargeThresholdEnabled === false)
                boost.sawDisabled = true;
            // Respect a threshold restored externally, e.g. in GNOME Settings.
            if (boost.sawDisabled && device.ChargeThresholdEnabled) {
                this._boosted.delete(path);
                continue;
            }
            // Some firmware calls the preservation limit "full". Wait for the
            // battery to leave that pre-boost state, or actually reach 100%.
            if (device.State !== UPower.DeviceState.FULLY_CHARGED)
                boost.ignoreInitialFull = false;
            const full = device.Percentage >= 100 ||
                (!boost.ignoreInitialFull && device.State === UPower.DeviceState.FULLY_CHARGED);
            if (!boost.restoreFailed &&
                (!onAC || full || !device.IsPresent || !this._devices.has(path)))
                this._restore(path);
        }

        const active = this._boosted.size > 0;
        const restoreFailed = [...this._boosted.values()].some(boost => boost.restoreFailed);
        const candidates = this._candidates();
        this._toggle.visible = active || (onAC && candidates.length > 0);
        this._toggle.reactive = active || (onAC && candidates.some(d => d.Percentage < 100));
        this._toggle.can_focus = this._toggle.reactive;
        this._toggle.checked = active;
        this._toggle.subtitle = restoreFailed
            ? _('Restore failed — click to retry')
            : this._error ?? (active ? _('Active — click to cancel') : _('Charge to Full'));
        this._indicator.visible = active;
    }

    destroy() {
        this._closed = true;
        // Restore only batteries for which we issued a disabling request.
        // Never cancel a write that might already have reached UPower.
        this._restoreAll();
        this._cancellable.cancel();
        for (const id of this._clientSignals)
            this._client.disconnect(id);
        this._clientSignals = [];
        for (const path of this._devices.keys())
            this._removeDevice(path);
        this._boosted.clear();
        this._client?.run_dispose();
        this._client = null;
        this._cancellable = null;
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class ChargeBoostExtension extends Extension {
    enable() {
        this._indicator = new ChargeBoostIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
