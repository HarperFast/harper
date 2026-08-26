'use strict';

const assert = require('node:assert');
const { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { symlinkHarperModule } = require('#src/components/componentLoader');
const { PACKAGE_ROOT } = require('#js/utility/packageUtils');

describe('symlinkHarperModule', () => {
	let componentDirectory;

	beforeEach(() => {
		componentDirectory = mkdtempSync(join(tmpdir(), 'harper-module-link-'));
	});

	afterEach(() => {
		rmSync(componentDirectory, { recursive: true, force: true });
	});

	it('skips the lock when the Harper module link is already valid', async () => {
		const nodeModulesDirectory = join(componentDirectory, 'node_modules');
		mkdirSync(nodeModulesDirectory);
		symlinkSync(PACKAGE_ROOT, join(nodeModulesDirectory, 'harper'), 'dir');

		await symlinkHarperModule(componentDirectory, {
			tryLock() {
				throw new Error('valid links must not take the lock');
			},
			unlock() {},
		});
	});

	it('repairs a dangling legacy harperdb link instead of treating it as absent', async () => {
		const nodeModulesDirectory = join(componentDirectory, 'node_modules');
		mkdirSync(nodeModulesDirectory);
		symlinkSync(PACKAGE_ROOT, join(nodeModulesDirectory, 'harper'), 'dir');
		symlinkSync(join(componentDirectory, 'missing'), join(nodeModulesDirectory, 'harperdb'), 'dir');
		const store = {
			tryLock() {
				return true;
			},
			unlock() {},
		};

		await symlinkHarperModule(componentDirectory, store);

		assert.strictEqual(readlinkSync(join(nodeModulesDirectory, 'harperdb')), PACKAGE_ROOT);
	});

	it('does not unlock another owner when a lock wait times out', async () => {
		let unlockCount = 0;
		const store = {
			tryLock() {
				return false;
			},
			unlock() {
				unlockCount++;
			},
		};

		await assert.rejects(symlinkHarperModule(componentDirectory, store, 20), /timed out/);
		assert.strictEqual(unlockCount, 0);
	});

	it('clears the lock winner timeout after releasing its lock', async () => {
		let unlockCount = 0;
		const store = {
			tryLock() {
				return true;
			},
			unlock() {
				unlockCount++;
			},
		};

		await symlinkHarperModule(componentDirectory, store, 20);
		await delay(40);
		assert.strictEqual(unlockCount, 1);
	});

	it('resolves a lock waiter only after the winning worker repaired the links', async () => {
		let notifyUnlocked;
		const store = {
			tryLock(_key, callback) {
				notifyUnlocked = callback;
				return false;
			},
			unlock() {
				throw new Error('waiter must not unlock');
			},
		};
		const linked = symlinkHarperModule(componentDirectory, store, 100);

		const nodeModulesDirectory = join(componentDirectory, 'node_modules');
		mkdirSync(nodeModulesDirectory);
		symlinkSync(PACKAGE_ROOT, join(nodeModulesDirectory, 'harper'), 'dir');
		notifyUnlocked();

		await linked;
	});
});
