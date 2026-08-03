'use strict';

const assert = require('node:assert');

const { forceDowngradePrompt } = require('#src/upgrade/upgradePrompt');
const { UpgradeObject } = require('#src/upgrade/UpgradeObjects');

// Regression coverage for #2046: starting an older binary against data a newer minor version has
// upgraded reaches forceDowngradePrompt, which blocks on stdin. With no terminal attached
// (systemd, containers, CI) the process hung forever with nothing in the log. Non-interactive
// starts must fail fast with an actionable error instead, and a CONFIRM_DOWNGRADE override must
// still answer the prompt without a terminal.
describe('forceDowngradePrompt — non-interactive starts', () => {
	const upgradeObj = new UpgradeObject('5.2.0', '5.1.22');
	let originalIsTTY;
	let originalEnv;
	let originalArgv;

	beforeEach(() => {
		originalIsTTY = process.stdin.isTTY;
		originalEnv = process.env.CONFIRM_DOWNGRADE;
		originalArgv = process.argv;
		process.stdin.isTTY = false;
		delete process.env.CONFIRM_DOWNGRADE;
		// Other test files push --CONFIRM_DOWNGRADE into argv without cleanup; scrub the flag and
		// its value so these tests control the override.
		process.argv = process.argv.filter(
			(arg, i, argv) => arg !== '--CONFIRM_DOWNGRADE' && argv[i - 1] !== '--CONFIRM_DOWNGRADE'
		);
	});

	afterEach(() => {
		process.stdin.isTTY = originalIsTTY;
		process.argv = originalArgv;
		if (originalEnv === undefined) delete process.env.CONFIRM_DOWNGRADE;
		else process.env.CONFIRM_DOWNGRADE = originalEnv;
	});

	it('throws instead of blocking when there is no TTY and no override', async () => {
		await assert.rejects(forceDowngradePrompt(upgradeObj), (error) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes('5.2.0'));
			assert.ok(error.message.includes('5.1.22'));
			assert.ok(error.message.includes('CONFIRM_DOWNGRADE'));
			return true;
		});
	});

	it('proceeds without a TTY when CONFIRM_DOWNGRADE=yes', async () => {
		process.env.CONFIRM_DOWNGRADE = 'yes';
		assert.strictEqual(await forceDowngradePrompt(upgradeObj), true);
	});

	it('accepts the override case-insensitively (the prompt library would reject YES and hang)', async () => {
		process.env.CONFIRM_DOWNGRADE = 'YES';
		assert.strictEqual(await forceDowngradePrompt(upgradeObj), true);
	});

	it('declines without a TTY when CONFIRM_DOWNGRADE=no', async () => {
		process.env.CONFIRM_DOWNGRADE = 'no';
		assert.strictEqual(await forceDowngradePrompt(upgradeObj), false);
	});

	it('throws on an unrecognized override value instead of falling through to the blocking prompt', async () => {
		process.env.CONFIRM_DOWNGRADE = 'true';
		await assert.rejects(forceDowngradePrompt(upgradeObj), (error) => {
			assert.ok(error.message.includes("Unrecognized CONFIRM_DOWNGRADE value 'true'"));
			return true;
		});
	});
});
