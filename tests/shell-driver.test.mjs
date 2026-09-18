// Exercise the real test driver's startup gates without starting a desktop.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./shell-driver.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class ShellTestDriver', 'class ShellTestDriver');

function harness({startingUp = true, overviewVisible = true} = {}) {
    const events = [];
    const results = [];
    const timers = new Map();
    let nextTimer = 1;
    let timeMs = 0;
    // Stop at the first battery access, after both readiness gates. A distinct
    // error proves the driver progressed to discovery instead of timing out.
    const discoveryReached = new Error('Battery discovery reached');
    discoveryReached.stack = 'lookup@mock-shell.js:1:1';
    const Main = {
        layoutManager: {_startingUp: startingUp},
        overview: {
            visible: overviewVisible,
            hide() {
                events.push('hide overview');
                // Like Shell's animation, hide() does not finish immediately.
            },
        },
        extensionManager: {
            lookup() {
                events.push('discover battery');
                throw discoveryReached;
            },
        },
        get panel() {
            events.push('access panel');
            throw new Error('Unexpected panel access');
        },
    };
    const context = vm.createContext({
        Main,
        Extension: class {},
        QuickToggle: class {},
        Gio: {},
        GLib: {
            PRIORITY_DEFAULT: 0,
            SOURCE_REMOVE: false,
            SOURCE_CONTINUE: true,
            get_monotonic_time: () => timeMs * 1000,
            timeout_add(_priority, _interval, callback) {
                const id = nextTimer++;
                timers.set(id, callback);
                return id;
            },
            getenv(name) {
                assert.equal(name, 'CHARGEBOOST_TEST_RESULT');
                return '/mock/result.json';
            },
            file_set_contents(path, contents) {
                assert.equal(path, '/mock/result.json');
                results.push(JSON.parse(contents));
            },
        },
    });
    const driver = vm.runInContext(`${source}\nnew ShellTestDriver();`, context);
    return {
        Main,
        driver,
        events,
        results,
        timers,
        discoveryReached,
        async advance(milliseconds = 25) {
            timeMs += milliseconds;
            for (const [id, callback] of [...timers]) {
                if (!callback())
                    timers.delete(id);
                // A resolved readiness promise may schedule the next gate.
                await new Promise(resolve => setImmediate(resolve));
            }
        },
    };
}

test('driver waits for Shell startup and overview closure before accessing the extension', async () => {
    const h = harness();
    h.driver.enable();
    await h.advance(1000);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.results, []);

    h.Main.layoutManager._startingUp = false;
    await h.advance();
    assert.deepEqual(h.events, ['hide overview']);

    await h.advance(1000);
    assert.deepEqual(h.events, ['hide overview']);
    assert.deepEqual(h.results, []);

    h.Main.overview.visible = false;
    await h.advance();
    await h.advance();
    assert.deepEqual(h.events, ['hide overview', 'discover battery']);
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].ok, false);
    assert.equal(h.results[0].error,
        `${h.discoveryReached.message}\n${h.discoveryReached.stack}`);
    assert.equal(h.timers.size, 0);
});

test('driver proceeds when Shell startup and overview closure already finished', async () => {
    const h = harness({startingUp: false, overviewVisible: false});
    h.driver.enable();
    await h.advance();
    await h.advance();
    await h.advance();
    assert.deepEqual(h.events, ['hide overview', 'discover battery']);
    assert.equal(h.results.length, 1);
    assert.match(h.results[0].error, /^Battery discovery reached\nlookup@/);
    assert.equal(h.timers.size, 0);
});

test('startup failure has a bounded timeout and reports its assertion message', async () => {
    const h = harness();
    h.driver.enable();
    await h.advance(14_999);
    assert.deepEqual(h.results, []);
    await h.advance(1);
    assert.deepEqual(h.events, []);
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].ok, false);
    assert.match(h.results[0].error, /^Timed out: GNOME Shell startup completes\n/);
    assert.equal(h.timers.size, 0);
});

test('overview closure failure times out before accessing the extension or menu', async () => {
    const h = harness({startingUp: false});
    h.driver.enable();
    await h.advance();
    await h.advance(5000);
    assert.deepEqual(h.events, ['hide overview']);
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].ok, false);
    assert.match(h.results[0].error, /^Timed out: startup overview closes\n/);
    assert.equal(h.timers.size, 0);
});
