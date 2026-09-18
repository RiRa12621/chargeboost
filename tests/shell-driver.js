// Loaded only as a separate test extension inside the isolated Shell process.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const UUID = 'chargeboost@rackow.io';
const ROOT = '/org/freedesktop/UPower';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

// Bounded readiness checks belong to the test runner, never the extension.
function until(predicate, description) {
    return new Promise((resolve, reject) => {
        const deadline = GLib.get_monotonic_time() + 5_000_000;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            try {
                if (predicate()) {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }
                assert(GLib.get_monotonic_time() < deadline, `Timed out: ${description}`);
            } catch (error) {
                reject(error);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

function control(method, parameters = null) {
    return Gio.DBus.system.call_sync('org.freedesktop.UPower', ROOT,
        'io.rackow.ChargeBoost.Test', method, parameters, null,
        Gio.DBusCallFlags.NONE, 2000, null).deepUnpack();
}

function update(device, properties) {
    control('Update', new GLib.Variant('(sa{sv})', [device, properties]));
}

export default class ShellTestDriver extends Extension {
    enable() {
        this._run().then(
            tests => this._finish({ok: true, tests}),
            error => this._finish({ok: false, error: error.stack ?? error.message}));
    }

    disable() {}

    _finish(result) {
        GLib.file_set_contents(GLib.getenv('CHARGEBOOST_TEST_RESULT'), JSON.stringify(result));
    }

    async _run() {
        const tests = [];
        const extension = () => Main.extensionManager.lookup(UUID)?.stateObj;
        await until(() => extension()?._indicator?._devices.size === 2 &&
            extension()._indicator._toggle.visible, 'extension discovers the mock battery');
        let indicator = extension()._indicator;
        let toggle = indicator._toggle;
        const calls = () => control('GetCalls')[0];
        const expectCalls = expected => assert(JSON.stringify(calls()) === JSON.stringify(expected),
            `Unexpected threshold calls: ${JSON.stringify(calls())}`);
        const click = () => toggle.emit('clicked', 1);

        assert(toggle instanceof QuickToggle, 'Real QuickToggle is loaded');
        assert(toggle.title === 'Charge Boost' && toggle.subtitle === 'Charge to Full', 'Initial labels');
        assert(!toggle.checked && !indicator._indicator.visible, 'Initially inactive');
        expectCalls([]);
        tests.push('real Quick Settings widget and read-only startup');

        Main.panel.statusArea.quickSettings.menu.open();
        await until(() => toggle.mapped, 'Quick Settings actor is displayed');
        Main.panel.closeQuickSettings();
        tests.push('Quick Settings menu displays the real toggle');

        control('Invalidate', new GLib.Variant('(sa{sv})', ['battery', {
            ChargeThresholdSupported: new GLib.Variant('b', false),
        }]));
        await until(() => !toggle.visible, 'invalidated support property is fetched');
        control('Invalidate', new GLib.Variant('(sa{sv})', ['battery', {
            ChargeThresholdSupported: new GLib.Variant('b', true),
        }]));
        await until(() => toggle.visible, 'supported action returns');
        expectCalls([]);
        tests.push('Gio refetches invalidated D-Bus properties');

        click();
        await until(() => toggle.checked && indicator._indicator.visible, 'active UI');
        expectCalls([false]);
        click();
        await until(() => !toggle.checked && toggle.visible, 'manual restoration');
        expectCalls([false, true]);
        tests.push('click starts and cancels through real Gio D-Bus');

        click();
        update('ac', {Online: new GLib.Variant('b', false)});
        await until(() => !toggle.checked && !toggle.visible, 'AC unplug signal');
        expectCalls([false, true, false, true]);
        update('ac', {Online: new GLib.Variant('b', true)});
        await until(() => toggle.visible, 'AC reconnect signal');
        tests.push('AC Online property signal restores limits');

        click();
        update('battery', {Percentage: new GLib.Variant('d', 100)});
        await until(() => !toggle.checked && !toggle.reactive, '100 percent');
        expectCalls([false, true, false, true, false, true]);
        tests.push('full percentage signal restores limits');

        update('battery', {Percentage: new GLib.Variant('d', 83), State: new GLib.Variant('u', 1)});
        await until(() => toggle.reactive, 'battery ready again');
        click();
        update('battery', {State: new GLib.Variant('u', 4)});
        await until(() => !toggle.checked, 'FULLY_CHARGED signal');
        expectCalls([false, true, false, true, false, true, false, true]);
        tests.push('UPower fully-charged state restores limits');

        click();
        assert(toggle.checked, 'Boost can start from a cached full state at the limit');
        Main.extensionManager.disableExtension(UUID);
        await until(() => extension()?._indicator === null, 'active extension disable');
        expectCalls([false, true, false, true, false, true, false, true, false, true]);
        tests.push('real extension manager unload restores active limits');

        update('battery', {ChargeThresholdEnabled: new GLib.Variant('b', false)});
        Main.extensionManager.enableExtension(UUID);
        await until(() => extension()?._indicator?._devices.size === 2 &&
            [...extension()._indicator._devices.values()].every(entry => entry.device), 're-enable');
        indicator = extension()._indicator;
        toggle = indicator._toggle;
        assert(!toggle.visible && !toggle.checked, 'Externally disabled limits stay disabled');
        Main.extensionManager.disableExtension(UUID);
        await until(() => extension()?._indicator === null, 'inactive extension disable');
        expectCalls([false, true, false, true, false, true, false, true, false, true]);
        tests.push('re-enable and inactive unload leave external settings alone');

        const [properties] = Gio.DBus.system.call_sync('org.freedesktop.UPower', `${ROOT}/devices/battery_TEST`,
            'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['org.freedesktop.UPower.Device']), null,
            Gio.DBusCallFlags.NONE, 2000, null).deepUnpack();
        assert(properties.ChargeStartThreshold.unpack() === 67 &&
            properties.ChargeEndThreshold.unpack() === 83, 'Custom threshold percentages unchanged');
        tests.push('custom threshold percentages preserved');
        return tests;
    }
}
