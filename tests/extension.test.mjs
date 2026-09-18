// Run with: node --test tests/extension.test.mjs
// The actual extension runs in a VM with in-memory GI/UI substitutes. These
// tests never contact the system bus or change the machine's battery settings.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class ChargeBoostExtension', 'class ChargeBoostExtension');

const DeviceKind = {LINE_POWER: 1, BATTERY: 2};
const DeviceState = {CHARGING: 1, DISCHARGING: 2, FULLY_CHARGED: 4, PENDING_CHARGE: 5};

class Signals {
    signals = new Map();
    nextSignal = 1;
    g_name_owner = ':1.100';

    run_dispose() {
        this.disposed = true;
    }

    connect(name, callback) {
        const id = this.nextSignal++;
        this.signals.set(id, {name, callback});
        return id;
    }

    disconnect(id) {
        assert.ok(this.signals.delete(id), `Signal ${id} was connected`);
    }

    emit(name, ...args) {
        for (const signal of [...this.signals.values()]) {
            if (signal.name === name)
                signal.callback(this, ...args);
        }
    }
}

function battery(name = 'BAT0', properties = {}) {
    return Object.assign(new Signals(), {
        get_object_path: () => `/org/freedesktop/UPower/devices/battery_${name}`,
        Type: DeviceKind.BATTERY,
        PowerSupply: true,
        IsPresent: true,
        ChargeThresholdSupported: true,
        ChargeThresholdEnabled: true,
        Percentage: 80,
        State: DeviceState.PENDING_CHARGE,
    }, properties);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function harness(t, {batteries = [battery()], initialize = true, onCall,
    deferDeviceInit = false, clientError, enumerationError, deviceError} = {}) {
    const ac = Object.assign(new Signals(), {
        get_object_path: () => '/org/freedesktop/UPower/devices/line_power_AC',
        Type: DeviceKind.LINE_POWER,
        Online: true,
    });
    const client = Object.assign(new Signals(), {OnBattery: false});
    const writes = [];
    const errors = [];
    const cancellables = [];
    const availableDevices = new Map([ac, ...batteries].map(d => [d.get_object_path(), d]));
    const pendingDeviceInits = new Map();
    const allDevices = new Set(availableDevices.values());
    const indicators = [];
    const proxyRequests = [];
    let finishClient;
    let finishDevices;
    let indicator;
    client.EnumerateDevicesAsync = () => new Promise((resolve, reject) => {
        finishDevices = () => enumerationError
            ? reject(enumerationError) : resolve([[...availableDevices.keys()]]);
    });

    class Widget extends Signals {
        constructor(properties = {}) {
            super();
            Object.assign(this, properties);
        }

        destroy() {
            this.destroyed = true;
            this.signals.clear();
        }
    }

    class SystemIndicator extends Widget {
        quickSettingsItems = [];

        _addIndicator() {
            return new Widget();
        }
    }

    const context = vm.createContext({
        Gio: {
            Cancellable: class {
                constructor() {
                    this.cancelled = false;
                    cancellables.push(this);
                }

                cancel() {
                    this.cancelled = true;
                }
            },
            IOErrorEnum: {CANCELLED: 19},
            DBusCallFlags: {NONE: 0},
            DBusProxyFlags: {DO_NOT_AUTO_START: 1, GET_INVALIDATED_PROPERTIES: 2},
            DBusProxy: {makeProxyWrapper(xml) {
                const isDevice = xml.includes('org.freedesktop.UPower.Device');
                return {newAsync(_bus, busName, path, cancellable, flags) {
                    assert.equal(busName, 'org.freedesktop.UPower');
                    assert.equal(cancellable, cancellables.at(-1));
                    assert.equal(flags, 3);
                    if (!isDevice) {
                        return new Promise((resolve, reject) => {
                            finishClient = () => clientError ? reject(clientError) : resolve(client);
                        });
                    }
                    proxyRequests.push(path);
                    if (deviceError)
                        return Promise.reject(deviceError);
                    const device = availableDevices.get(path);
                    assert.ok(device, `No test device for ${path}`);
                    if (!deferDeviceInit)
                        return Promise.resolve(device);
                    return new Promise(resolve => {
                        const pending = pendingDeviceInits.get(path) ?? [];
                        pending.push(() => resolve(device));
                        pendingDeviceInits.set(path, pending);
                    });
                }};
            }},
            DBus: {system: {
                call_sync(bus, path, iface, method, parameters, replyType, flags, timeout, cancellable) {
                    assert.equal(bus, 'org.freedesktop.UPower');
                    assert.equal(iface, 'org.freedesktop.UPower.Device');
                    assert.equal(method, 'EnableChargeThreshold');
                    assert.equal(parameters.signature, '(b)');
                    assert.equal(typeof parameters.values[0], 'boolean');
                    assert.equal(replyType, null);
                    assert.equal(flags, 0);
                    assert.ok(timeout > 0 && timeout <= 2000);
                    assert.equal(cancellable, null);
                    const write = {path, enabled: parameters.values[0]};
                    writes.push(write);
                    onCall?.(write, writes);
                },
            }},
        },
        GLib: {Variant: class {
            constructor(signature, values) {
                this.signature = signature;
                this.values = values;
            }
        }},
        GObject: {registerClass: klass => klass},
        UPower: {
            DeviceKind,
            DeviceState,
        },
        Main: {panel: {statusArea: {quickSettings: {
            addExternalIndicator(value) {
                indicator = value;
                indicators.push(value);
            },
        }}}},
        Extension: class {},
        _: value => value,
        QuickToggle: Widget,
        SystemIndicator,
        console: {error: error => errors.push(error)},
    });
    vm.runInContext(`${source}\nglobalThis.extension = new ChargeBoostExtension();`, context);
    const {extension} = context;
    // Every scenario, including failures, must leave Shell without resources.
    t.after(() => {
        extension.disable();
        assert.equal(client.signals.size, 0, 'UPower client signals were disconnected');
        for (const device of allDevices)
            assert.equal(device.signals.size, 0, `${device.get_object_path()} signals were disconnected`);
        for (const cancellable of cancellables)
            assert.equal(cancellable.cancelled, true, 'Pending discovery was cancelled');
        for (const widget of indicators) {
            assert.equal(widget.destroyed, true, 'Indicator was destroyed');
            for (const item of widget.quickSettingsItems)
                assert.equal(item.destroyed, true, 'Quick Settings item was destroyed');
        }
    });
    extension.enable();
    if (initialize) {
        finishClient();
        await settle();
        finishDevices?.();
        await settle();
    }

    return {
        ac, batteries, cancellables, client, errors, extension, writes,
        get indicator() { return indicator; },
        get toggle() { return indicator.quickSettingsItems[0]; },
        proxyRequests, settle,
        click: () => indicator.quickSettingsItems[0].emit('clicked'),
        async finishClient() {
            finishClient();
            await settle();
        },
        async finishDevices() {
            finishDevices();
            await settle();
        },
        async finishDeviceInit(device) {
            pendingDeviceInits.get(device.get_object_path()).shift()();
            await settle();
        },
        hasPendingDevices: () => Boolean(finishDevices),
        deviceSignal(name, device) {
            const path = device.get_object_path();
            if (name === 'DeviceAdded') {
                availableDevices.set(path, device);
                allDevices.add(device);
            } else if (name === 'DeviceRemoved') {
                availableDevices.delete(path);
            }
            client.emit('g-signal', ':1.100', name, {deepUnpack: () => [path]});
        },
        notify(device, properties) {
            Object.assign(device, properties);
            device.emit('g-properties-changed');
        },
    };
}

const write = (device, enabled) => ({path: device.get_object_path(), enabled});

test('startup and inactive shutdown never write thresholds, and release signals', async t => {
    const h = await harness(t);
    assert.equal(h.toggle.visible, true);
    assert.equal(h.toggle.reactive, true);
    assert.equal(h.toggle.checked, false);
    assert.equal(h.toggle.subtitle, 'Charge to Full');
    assert.equal(h.indicator._indicator.visible, false);
    assert.deepEqual(h.writes, []);
    h.extension.disable();
    assert.deepEqual(h.writes, []);
    assert.equal(h.client.signals.size, 0);
    assert.equal(h.ac.signals.size, 0);
    assert.equal(h.batteries[0].signals.size, 0);
    assert.equal(h.cancellables[0].cancelled, true);
    assert.equal(h.toggle.destroyed, true);
    assert.equal(h.indicator.destroyed, true);
});

for (const [name, properties] of [
    ['unsupported', {ChargeThresholdSupported: false}],
    ['missing support property', {ChargeThresholdSupported: undefined}],
    ['missing enabled property', {ChargeThresholdEnabled: undefined}],
    ['threshold disabled externally', {ChargeThresholdEnabled: false}],
    ['absent', {IsPresent: false}],
    ['peripheral', {PowerSupply: false}],
]) {
    test(`${name} batteries cannot start a boost`, async t => {
        const h = await harness(t, {batteries: [battery('BAT0', properties)]});
        assert.equal(h.toggle.visible, false);
        assert.equal(h.toggle.reactive, false);
        h.click();
        h.extension.disable();
        assert.deepEqual(h.writes, []);
    });
}

test('battery power prevents starting and an AC signal exposes the action', async t => {
    const h = await harness(t);
    h.client.OnBattery = true;
    h.client.emit('g-properties-changed');
    assert.equal(h.toggle.visible, false);
    h.click();
    assert.deepEqual(h.writes, []);
    h.client.OnBattery = false;
    h.client.emit('g-properties-changed');
    assert.equal(h.toggle.visible, true);
});

test('explicit start disables once and manual cancellation restores once', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    h.click();
    assert.deepEqual(h.writes, [write(b, false)]);
    assert.equal(h.toggle.checked, true);
    assert.equal(h.indicator._indicator.visible, true);
    assert.match(h.toggle.subtitle, /Active.*cancel/);
    h.notify(b, {ChargeThresholdEnabled: false});
    assert.equal(h.toggle.visible, true);
    h.click();
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
    assert.equal(h.toggle.checked, false);
    assert.equal(h.indicator._indicator.visible, false);
    h.notify(b, {ChargeThresholdEnabled: true});
    assert.equal(h.toggle.visible, true);
    assert.equal(h.toggle.subtitle, 'Charge to Full');
    h.extension.disable();
    assert.equal(h.writes.length, 2);
});

for (const [name, disconnect] of [
    ['UPower on-battery', h => {
        h.client.OnBattery = true;
        h.client.emit('g-properties-changed');
    }],
    ['line-power offline', h => h.notify(h.ac, {Online: false})],
]) {
    test(`${name} signal ends a boost`, async t => {
        const h = await harness(t);
        const [b] = h.batteries;
        h.click();
        h.notify(b, {ChargeThresholdEnabled: false});
        disconnect(h);
        assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
        assert.equal(h.toggle.checked, false);
        assert.equal(h.toggle.visible, false);
    });
}

for (const [name, properties] of [
    ['100 percent', {Percentage: 100}],
    ['fully-charged state', {State: DeviceState.FULLY_CHARGED, Percentage: 99}],
]) {
    test(`${name} signal ends a boost`, async t => {
        const h = await harness(t);
        const [b] = h.batteries;
        h.click();
        h.notify(b, {ChargeThresholdEnabled: false, ...properties});
        assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
        assert.equal(h.toggle.checked, false);
    });
}

test('an initial fully-charged state at 80 percent does not cancel immediately', async t => {
    const b = battery('BAT0', {State: DeviceState.FULLY_CHARGED});
    const h = await harness(t, {batteries: [b]});
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false});
    assert.deepEqual(h.writes, [write(b, false)]);
    assert.equal(h.toggle.checked, true);
    h.notify(b, {State: DeviceState.CHARGING});
    h.notify(b, {State: DeviceState.FULLY_CHARGED, Percentage: 99});
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
});

test('100 percent also ends an initial full-state boost without a state transition', async t => {
    const b = battery('BAT0', {State: DeviceState.FULLY_CHARGED});
    const h = await harness(t, {batteries: [b]});
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false, Percentage: 100});
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
});

test('an already 100 percent battery does not get its threshold disabled', async t => {
    const h = await harness(t, {batteries: [battery('BAT0', {Percentage: 100})]});
    assert.equal(h.toggle.reactive, false);
    h.click();
    assert.deepEqual(h.writes, []);
});

test('external restoration ends ownership without another threshold write', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false});
    h.notify(b, {ChargeThresholdEnabled: true});
    assert.equal(h.toggle.checked, false);
    h.extension.disable();
    assert.deepEqual(h.writes, [write(b, false)]);
});

test('multiple eligible batteries restore independently, with one active action', async t => {
    const b0 = battery();
    const b1 = battery('BAT1', {Percentage: 65});
    const peripheral = battery('mouse', {PowerSupply: false});
    const h = await harness(t, {batteries: [b0, b1, peripheral]});
    h.click();
    assert.deepEqual(h.writes, [write(b0, false), write(b1, false)]);
    h.notify(b0, {ChargeThresholdEnabled: false, Percentage: 100});
    assert.equal(h.toggle.checked, true);
    assert.deepEqual(h.writes, [write(b0, false), write(b1, false), write(b0, true)]);
    h.notify(b1, {ChargeThresholdEnabled: false});
    h.click();
    assert.deepEqual(h.writes, [
        write(b0, false), write(b1, false), write(b0, true), write(b1, true),
    ]);
    assert.equal(h.toggle.checked, false);
});

test('a partial start error rolls back both confirmed and potentially applied writes', async t => {
    const b0 = battery();
    const b1 = battery('BAT1');
    const h = await harness(t, {batteries: [b0, b1], onCall({path, enabled}) {
        if (path === b1.get_object_path() && !enabled)
            throw new Error('D-Bus response lost');
    }});
    h.click();
    assert.deepEqual(h.writes, [
        write(b0, false), write(b1, false), write(b0, true), write(b1, true),
    ]);
    assert.equal(h.toggle.checked, false);
    assert.match(h.toggle.subtitle, /Could not start/);
    assert.equal(h.errors.length, 1);
    h.extension.disable();
    assert.equal(h.writes.length, 4);
});

test('restore failure remains active for explicit retry and does not retry on every signal', async t => {
    let failRestore = true;
    const h = await harness(t, {onCall({enabled}) {
        if (enabled && failRestore)
            throw new Error('UPower unavailable');
    }});
    const [b] = h.batteries;
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false});
    h.click();
    assert.equal(h.toggle.checked, true);
    assert.equal(h.toggle.reactive, true);
    assert.match(h.toggle.subtitle, /Restore failed.*retry/);
    h.notify(b, {Percentage: 90});
    h.notify(h.ac, {Online: false});
    assert.equal(h.writes.length, 2);
    failRestore = false;
    h.click();
    assert.deepEqual(h.writes, [write(b, false), write(b, true), write(b, true)]);
    assert.equal(h.toggle.checked, false);
    assert.equal(h.errors.length, 1);
});

test('active shutdown completes restoration before disconnecting signals', async t => {
    let h;
    h = await harness(t, {onCall({enabled}) {
        if (enabled) {
            assert.ok(h.client.signals.size > 0);
            assert.ok(h.batteries[0].signals.size > 0);
            assert.equal(h.indicator.destroyed, undefined);
        }
    }});
    const [b] = h.batteries;
    h.click();
    h.extension.disable();
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
    assert.equal(h.client.signals.size, 0);
    assert.equal(b.signals.size, 0);
    assert.equal(h.toggle.destroyed, true);
    assert.deepEqual(h.errors, []);
});

test('shutdown still cleans up after a restoration error', async t => {
    const h = await harness(t, {onCall({enabled}) {
        if (enabled)
            throw new Error('UPower unavailable');
    }});
    h.click();
    h.extension.disable();
    assert.equal(h.writes.length, 2);
    assert.equal(h.errors.length, 1);
    assert.equal(h.client.signals.size, 0);
    assert.equal(h.batteries[0].signals.size, 0);
    assert.equal(h.toggle.destroyed, true);
});

test('client initialization completing after shutdown cannot attach signals', async t => {
    const h = await harness(t, {initialize: false});
    h.extension.disable();
    await h.finishClient();
    assert.equal(h.hasPendingDevices(), false);
    assert.equal(h.client.signals.size, 0);
    assert.deepEqual(h.writes, []);
    assert.equal(h.cancellables[0].cancelled, true);
});

test('device enumeration completing after shutdown cannot attach signals', async t => {
    const h = await harness(t, {initialize: false});
    await h.finishClient();
    h.extension.disable();
    await h.finishDevices();
    assert.equal(h.client.signals.size, 0);
    assert.equal(h.ac.signals.size, 0);
    assert.equal(h.batteries[0].signals.size, 0);
    assert.deepEqual(h.writes, []);
});

test('device removal restores an owned threshold and disconnects its signal', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    h.click();
    h.deviceSignal('DeviceRemoved', b);
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
    assert.equal(b.signals.size, 0);
    assert.equal(h.toggle.checked, false);
});

test('device-added exposes a newly attached supported battery without writes', async t => {
    const h = await harness(t, {batteries: []});
    assert.equal(h.toggle.visible, false);
    const b = battery();
    h.deviceSignal('DeviceAdded', b);
    await h.settle();
    assert.equal(h.toggle.visible, true);
    assert.equal(b.signals.size, 1);
    assert.deepEqual(h.writes, []);
    h.extension.disable();
    assert.equal(b.signals.size, 0);
});

test('concurrent DeviceAdded and enumeration do not initialize a proxy twice', async t => {
    const h = await harness(t, {initialize: false, deferDeviceInit: true});
    const [b] = h.batteries;
    await h.finishClient();
    h.deviceSignal('DeviceAdded', b);
    await h.finishDevices();
    assert.equal(h.proxyRequests.filter(path => path === b.get_object_path()).length, 1);
    await h.finishDeviceInit(h.ac);
    await h.finishDeviceInit(b);
    assert.equal(b.signals.size, 1);
    assert.equal(h.toggle.visible, true);
    h.extension.disable();
    assert.equal(b.signals.size, 0);
    assert.deepEqual(h.writes, []);
});

test('a removed device whose proxy initializes late stays removed and is disposed', async t => {
    const h = await harness(t, {deferDeviceInit: true});
    const [b] = h.batteries;
    h.deviceSignal('DeviceRemoved', b);
    await h.finishDeviceInit(h.ac);
    await h.finishDeviceInit(b);
    assert.equal(b.signals.size, 0);
    assert.equal(b.disposed, true);
    assert.equal(h.toggle.visible, false);
    assert.deepEqual(h.writes, []);
});

test('a device proxy initializing after shutdown is disposed without connecting signals', async t => {
    const h = await harness(t, {deferDeviceInit: true});
    h.extension.disable();
    await h.finishDeviceInit(h.ac);
    await h.finishDeviceInit(h.batteries[0]);
    for (const device of [h.ac, ...h.batteries]) {
        assert.equal(device.disposed, true);
        assert.equal(device.signals.size, 0);
    }
    assert.equal(h.client.disposed, true);
    assert.deepEqual(h.writes, []);
});

test('daemon name-owner loss hides an inactive action and blocks starting', async t => {
    const h = await harness(t);
    h.client.g_name_owner = null;
    h.client.emit('notify::g-name-owner');
    assert.equal(h.toggle.visible, false);
    h.click();
    assert.deepEqual(h.writes, []);
});

for (const option of ['clientError', 'enumerationError', 'deviceError']) {
    test(`${option} is logged and leaves no writes or connected signals after disable`, async t => {
        const h = await harness(t, {[option]: new Error('UPower read failed')});
        assert.equal(h.errors.length, 1);
        assert.equal(h.toggle.visible, false);
        h.extension.disable();
        assert.equal(h.client.signals.size, 0);
        assert.equal(h.ac.signals.size, 0);
        assert.equal(h.batteries[0].signals.size, 0);
        assert.deepEqual(h.writes, []);
    });
}

test('custom charge percentages remain unchanged during start, cancel, and unload', async t => {
    const b = battery();
    // A write to either property throws, including direct proxy assignments.
    Object.defineProperties(b, {
        ChargeStartThreshold: {value: 55, writable: false},
        ChargeEndThreshold: {value: 85, writable: false},
    });
    const h = await harness(t, {batteries: [b]});
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false});
    h.click();
    h.notify(b, {ChargeThresholdEnabled: true});
    h.click();
    h.extension.disable();
    assert.deepEqual(h.writes, [
        write(b, false), write(b, true), write(b, false), write(b, true),
    ]);
    assert.equal(b.ChargeStartThreshold, 55);
    assert.equal(b.ChargeEndThreshold, 85);
    assert.deepEqual(h.errors, []);
});

test('external support and enabled changes update availability without changing settings', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    h.notify(b, {ChargeThresholdEnabled: false});
    assert.equal(h.toggle.visible, false);
    h.click();
    h.notify(b, {ChargeThresholdEnabled: true, ChargeThresholdSupported: false});
    assert.equal(h.toggle.visible, false);
    h.click();
    h.notify(b, {ChargeThresholdSupported: true});
    assert.equal(h.toggle.visible, true);
    assert.equal(h.toggle.reactive, true);
    assert.deepEqual(h.writes, []);
});

test('an online second AC adapter keeps boost active until all adapters disconnect', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    const secondAC = Object.assign(new Signals(), {
        get_object_path: () => '/org/freedesktop/UPower/devices/line_power_USB_C',
        Type: DeviceKind.LINE_POWER,
        Online: true,
    });
    h.deviceSignal('DeviceAdded', secondAC);
    await h.settle();
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false});
    h.notify(h.ac, {Online: false});
    assert.equal(h.toggle.checked, true);
    assert.deepEqual(h.writes, [write(b, false)]);
    h.notify(secondAC, {Online: false});
    assert.equal(h.toggle.checked, false);
    assert.equal(h.toggle.visible, false);
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
});

test('removing the last AC adapter restores boost even before OnBattery updates', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false});
    h.deviceSignal('DeviceRemoved', h.ac);
    assert.equal(h.client.OnBattery, false);
    assert.equal(h.toggle.checked, false);
    assert.equal(h.toggle.visible, false);
    assert.equal(h.ac.signals.size, 0);
    assert.equal(h.ac.disposed, true);
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
});

test('boost affects only eligible batteries in a mixed device set', async t => {
    const eligible = battery();
    const h = await harness(t, {batteries: [
        eligible,
        battery('disabled', {ChargeThresholdEnabled: false}),
        battery('unsupported', {ChargeThresholdSupported: false}),
        battery('full', {Percentage: 100}),
        battery('peripheral', {PowerSupply: false}),
        battery('absent', {IsPresent: false}),
    ]});
    h.click();
    h.extension.disable();
    assert.deepEqual(h.writes, [write(eligible, false), write(eligible, true)]);
});

test('duplicate completion signals cannot restore a threshold more than once', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false, Percentage: 100});
    h.notify(b, {State: DeviceState.FULLY_CHARGED});
    h.notify(b, {Percentage: 100});
    h.notify(h.ac, {Online: false});
    h.client.emit('g-properties-changed');
    h.extension.disable();
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
});

test('one failed restoration does not block other batteries or repeat successful writes', async t => {
    const b0 = battery();
    const b1 = battery('BAT1');
    let failRestore = true;
    const h = await harness(t, {batteries: [b0, b1], onCall({path, enabled}) {
        if (path === b0.get_object_path() && enabled && failRestore)
            throw new Error('BAT0 restore failed');
    }});
    h.click();
    h.notify(b0, {ChargeThresholdEnabled: false});
    h.notify(b1, {ChargeThresholdEnabled: false});
    h.click();
    assert.deepEqual(h.writes, [
        write(b0, false), write(b1, false), write(b0, true), write(b1, true),
    ]);
    assert.equal(h.toggle.checked, true);
    assert.match(h.toggle.subtitle, /Restore failed/);
    failRestore = false;
    h.click();
    h.extension.disable();
    assert.deepEqual(h.writes, [
        write(b0, false), write(b1, false), write(b0, true), write(b1, true), write(b0, true),
    ]);
    assert.equal(h.errors.length, 1);
});

test('a failed start and failed rollback retain ownership until manual restoration succeeds', async t => {
    let unavailable = true;
    const h = await harness(t, {onCall() {
        if (unavailable)
            throw new Error('UPower unavailable');
    }});
    const [b] = h.batteries;
    h.click();
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
    assert.equal(h.toggle.checked, true);
    assert.match(h.toggle.subtitle, /Restore failed/);
    h.notify(h.ac, {Online: false});
    assert.equal(h.writes.length, 2);
    unavailable = false;
    h.click();
    h.extension.disable();
    assert.deepEqual(h.writes, [write(b, false), write(b, true), write(b, true)]);
    assert.equal(h.errors.length, 2);
});

test('external restoration after a failed cancellation releases ownership without another write', async t => {
    const h = await harness(t, {onCall({enabled}) {
        if (enabled)
            throw new Error('Restore response lost');
    }});
    const [b] = h.batteries;
    h.click();
    h.notify(b, {ChargeThresholdEnabled: false});
    h.click();
    assert.equal(h.toggle.checked, true);
    h.notify(b, {ChargeThresholdEnabled: true});
    assert.equal(h.toggle.checked, false);
    assert.equal(h.toggle.subtitle, 'Charge to Full');
    h.extension.disable();
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
    assert.equal(h.errors.length, 1);
});

test('a removed battery restores its owned threshold when it returns after a failed write', async t => {
    let available = true;
    const h = await harness(t, {onCall({enabled}) {
        if (enabled && !available)
            throw new Error('Battery is disconnected');
    }});
    const [oldBattery] = h.batteries;
    h.click();
    h.notify(oldBattery, {ChargeThresholdEnabled: false});
    available = false;
    h.deviceSignal('DeviceRemoved', oldBattery);
    assert.equal(h.toggle.checked, true);
    assert.match(h.toggle.subtitle, /Restore failed/);
    assert.equal(oldBattery.signals.size, 0);
    assert.equal(oldBattery.disposed, true);
    const returnedBattery = battery('BAT0', {ChargeThresholdEnabled: false});
    available = true;
    h.deviceSignal('DeviceAdded', returnedBattery);
    await h.settle();
    assert.equal(returnedBattery.signals.size, 1);
    assert.equal(h.toggle.checked, false);
    assert.deepEqual(h.writes, [
        write(oldBattery, false), write(oldBattery, true), write(returnedBattery, true),
    ]);
    assert.equal(h.errors.length, 1);
});

test('a late proxy from before removal cannot replace a newly attached battery', async t => {
    const h = await harness(t, {deferDeviceInit: true});
    const [oldBattery] = h.batteries;
    h.deviceSignal('DeviceRemoved', oldBattery);
    const newBattery = battery('BAT0');
    h.deviceSignal('DeviceAdded', newBattery);
    await h.finishDeviceInit(h.ac);
    await h.finishDeviceInit(oldBattery);
    assert.equal(oldBattery.disposed, true);
    assert.equal(oldBattery.signals.size, 0);
    assert.equal(h.toggle.visible, false);
    await h.finishDeviceInit(newBattery);
    assert.equal(newBattery.signals.size, 1);
    assert.equal(h.toggle.visible, true);
    assert.deepEqual(h.writes, []);
});

test('repeated enable and disable creates fresh UI without duplicate signals or stale ownership', async t => {
    const h = await harness(t);
    const [b] = h.batteries;
    const firstIndicator = h.indicator;
    const firstToggle = h.toggle;
    const initialClientSignals = h.client.signals.size;
    const initialBatterySignals = b.signals.size;
    const initialACSignals = h.ac.signals.size;
    h.click();
    h.extension.disable();
    h.extension.disable();
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
    assert.equal(firstToggle.destroyed, true);
    for (let cycle = 0; cycle < 2; cycle++) {
        h.extension.enable();
        await h.finishClient();
        await h.finishDevices();
        assert.notEqual(h.indicator, firstIndicator);
        assert.notEqual(h.toggle, firstToggle);
        assert.equal(h.toggle.checked, false);
        assert.equal(h.toggle.visible, true);
        assert.equal(h.client.signals.size, initialClientSignals);
        assert.equal(b.signals.size, initialBatterySignals);
        assert.equal(h.ac.signals.size, initialACSignals);
        h.extension.disable();
        assert.equal(h.client.signals.size, 0);
        assert.equal(b.signals.size, 0);
        assert.equal(h.ac.signals.size, 0);
    }
    assert.deepEqual(h.writes, [write(b, false), write(b, true)]);
});

test('cancelled discovery after shutdown is silent and cannot create UI or writes', async t => {
    const cancelled = Object.assign(new Error('Operation was cancelled'), {
        matches: (domain, code) => domain.CANCELLED === code,
    });
    const h = await harness(t, {initialize: false, clientError: cancelled});
    h.extension.disable();
    await h.finishClient();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.writes, []);
    assert.equal(h.hasPendingDevices(), false);
    assert.equal(h.toggle.destroyed, true);
});
