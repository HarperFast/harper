const { ArmGate, armGraceMs } = require('#src/config/watcherArming');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');

// The grace itself is platform-derived (darwin only), so a case can assert when the callback runs
// relative to `arm()` only by waiting for it.
async function waitForArmed(gate) {
	for (let waited = 0; waited < 3000 && !gate.armed; waited += 5) await delay(5);
	return gate.armed;
}

describe('armGraceMs', () => {
	// The gate cases below observe only the grace of the host they run on, so on Linux CI they are
	// all satisfied by a grace of 0 — which is exactly the regression worth catching, since darwin
	// is the platform that needs one at all. Pinned per platform so the measurement is asserted
	// from any host. See DESIGN.md, "`ready` means the watcher is armed", for where the value came
	// from: writing 0ms after `ready` loses the write, 5ms and beyond delivers it.
	it("gives darwin a grace over chokidar's own ready, and no other platform one", () => {
		assert.ok(armGraceMs('darwin') >= 5, `darwin must keep a grace (got ${armGraceMs('darwin')}ms)`);
		for (const platform of ['linux', 'win32', 'freebsd']) {
			assert.equal(armGraceMs(platform), 0, `${platform} arms inside chokidar's own ready dispatch`);
		}
	});

	it('derives the process default from this platform', () => {
		assert.equal(armGraceMs(), armGraceMs(process.platform));
	});
});

describe('ArmGate', () => {
	it('runs the arming callback once and reports itself armed', async () => {
		const gate = new ArmGate();
		let armings = 0;

		assert.equal(gate.armed, false, 'a fresh gate is not armed');
		gate.arm(() => armings++);
		assert.equal(await waitForArmed(gate), true, 'the gate must arm');
		assert.equal(armings, 1, 'the arming callback must run exactly once');
	});

	it('ignores a repeat arm, from a second scan or a replacement watcher', async () => {
		const gate = new ArmGate();
		let armings = 0;

		gate.arm(() => armings++);
		await waitForArmed(gate);
		gate.arm(() => armings++);
		await delay(50);

		assert.equal(armings, 1, 'only the first arm may re-read');
	});

	it('cancels a grace that is still counting down, and never un-arms one that is not', async () => {
		const pending = new ArmGate();
		let armings = 0;
		pending.arm(() => armings++);
		pending.cancel();
		await delay(50);
		// Where there is no grace the callback has already run inside `arm`; where there is one,
		// cancelling it before it elapses is the watcher generation being torn down.
		assert.equal(armings, pending.armed ? 1 : 0, 'a cancelled grace must not arm the gate');

		const armed = new ArmGate();
		armed.arm(() => {});
		await waitForArmed(armed);
		armed.cancel();
		assert.equal(armed.armed, true, 'cancel must not un-arm a gate that has already armed');
	});
});

// Unit tests run on ubuntu only, where `armGraceMs()` is 0, so every case above takes the
// synchronous branch and a regression in the timer one ships green on the platform that needs it.
describe('ArmGate with a grace', () => {
	it('defers arming until the grace elapses', async () => {
		const gate = new ArmGate(20);
		let armings = 0;

		gate.arm(() => armings++);
		assert.equal(gate.armed, false, 'the gate must not arm inside `arm()` when it has a grace');
		assert.equal(armings, 0, 'the re-read must wait out the warm-up chokidar cannot report');

		assert.equal(await waitForArmed(gate), true, 'the grace must arm the gate');
		assert.equal(armings, 1, 'the arming callback must run exactly once');
	});

	it('drops a grace cancelled before it elapses, and never arms after', async () => {
		const gate = new ArmGate(20);
		let armings = 0;

		gate.arm(() => armings++);
		gate.cancel();
		await delay(60);

		assert.equal(gate.armed, false, 'a cancelled grace must leave the gate unarmed');
		assert.equal(armings, 0, 'a torn-down generation must not re-read');
	});

	it('lets a replacement watcher arm again after reset', async () => {
		const gate = new ArmGate(20);
		let armings = 0;

		gate.arm(() => armings++);
		await waitForArmed(gate);
		gate.reset();
		assert.equal(gate.armed, false, 'reset must open the gate for the replacement generation');

		gate.arm(() => armings++);
		assert.equal(await waitForArmed(gate), true, 'the replacement must arm on its own scan');
		assert.equal(armings, 2, 'the replacement re-reads as the first generation did');
	});

	it('drops a grace still pending when the generation is replaced', async () => {
		const gate = new ArmGate(20);
		let armings = 0;

		gate.arm(() => armings++);
		gate.reset();
		await delay(60);

		assert.equal(armings, 0, 'the replaced generation must not arm the gate for its successor');
		assert.equal(gate.armed, false, 'the replacement has not scanned yet');
	});
});
