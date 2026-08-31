'use strict';

const assert = require('node:assert');
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readConfigFileSync } = require('#src/config/readConfigFileSync');

const READ_RETRY_BUDGET_MS = 500;
const CONTENTS = 'rootPath: /tmp/hdb';

// A real mode-000 file is the only way to make readFileSync fail the way a Windows sharing
// violation does without stubbing node:fs, which AGENTS.md forbids. Root ignores the mode, and
// Windows has no POSIX modes at all, so the whole suite opts out where the lock cannot be taken.
function canDenyReads(filePath) {
	chmodSync(filePath, 0o000);
	try {
		readFileSync(filePath, 'utf-8');
		return false;
	} catch {
		return true;
	} finally {
		chmodSync(filePath, 0o644);
	}
}

describe('readConfigFileSync', () => {
	let fixture;
	let originalPlatform;

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), 'harper.unit-test.read-config-sync-'));
		originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', originalPlatform);
		rmSync(fixture, { recursive: true, force: true });
	});

	const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

	// The retry deadline is shared per path, so a case that must start with a fresh budget needs a
	// path no earlier case has poisoned.
	const lockedConfig = (name) => {
		const filePath = join(fixture, `${name}.yaml`);
		writeFileSync(filePath, CONTENTS);
		if (!canDenyReads(filePath)) return undefined;
		chmodSync(filePath, 0o000);
		return filePath;
	};

	it('returns the file contents', () => {
		const filePath = join(fixture, 'present.yaml');
		writeFileSync(filePath, CONTENTS);
		assert.equal(readConfigFileSync(filePath), CONTENTS);
	});

	it('rethrows a missing file without retrying', () => {
		setPlatform('win32');
		const startedAt = performance.now();
		assert.throws(() => readConfigFileSync(join(fixture, 'absent.yaml')), { code: 'ENOENT' });
		assert.ok(performance.now() - startedAt < READ_RETRY_BUDGET_MS, 'a missing file must fail immediately');
	});

	it('does not retry a denied read off Windows, where the permission failure is real', function () {
		setPlatform('linux');
		const filePath = lockedConfig('no-retry');
		if (!filePath) return this.skip();

		const startedAt = performance.now();
		assert.throws(() => readConfigFileSync(filePath), { code: 'EACCES' });
		assert.ok(performance.now() - startedAt < READ_RETRY_BUDGET_MS / 2, 'POSIX must fail fast');
	});

	it('retries a denied read on Windows and returns once the writer releases the file', function () {
		const filePath = lockedConfig('retry');
		if (!filePath) return this.skip();
		setPlatform('win32');

		// The retry loop never yields, so the release has to come from another process.
		const release = spawn('sh', ['-c', `sleep 0.15; chmod 644 '${filePath}'`], { stdio: 'ignore' });
		release.on('error', () => chmodSync(filePath, 0o644));
		release.unref();

		assert.equal(readConfigFileSync(filePath), CONTENTS);
	});

	it('gives up at the retry deadline and rethrows', function () {
		const filePath = lockedConfig('persistent');
		if (!filePath) return this.skip();
		setPlatform('win32');

		const startedAt = performance.now();
		assert.throws(() => readConfigFileSync(filePath), { code: 'EACCES' });
		const elapsedMs = performance.now() - startedAt;

		assert.ok(elapsedMs >= READ_RETRY_BUDGET_MS * 0.8, `gave up after ${elapsedMs}ms`);
		assert.ok(elapsedMs < READ_RETRY_BUDGET_MS * 4, `overran the budget: ${elapsedMs}ms`);
	});

	it('takes a single attempt when the caller owns the retry, so a ladder rung costs no stall', function () {
		const filePath = lockedConfig('single-attempt');
		if (!filePath) return this.skip();
		setPlatform('win32');

		const startedAt = performance.now();
		assert.throws(() => readConfigFileSync(filePath, false), { code: 'EACCES' });
		const elapsedMs = performance.now() - startedAt;

		assert.ok(elapsedMs < READ_RETRY_BUDGET_MS / 2, `a non-waiting read blocked for ${elapsedMs}ms`);
	});

	it('shares one deadline across callers reading the same path, so a burst costs one budget', function () {
		const filePath = lockedConfig('shared');
		if (!filePath) return this.skip();
		setPlatform('win32');

		assert.throws(() => readConfigFileSync(filePath), { code: 'EACCES' });

		// A sibling watcher reacting to the same change event must not spend a second budget on
		// the calling worker's event loop.
		const startedAt = performance.now();
		assert.throws(() => readConfigFileSync(filePath), { code: 'EACCES' });
		const elapsedMs = performance.now() - startedAt;

		assert.ok(elapsedMs < READ_RETRY_BUDGET_MS / 2, `the sibling read blocked for ${elapsedMs}ms`);
	});

	it('starts a fresh budget once a read succeeds', function () {
		const filePath = lockedConfig('recovered');
		if (!filePath) return this.skip();
		setPlatform('win32');

		assert.throws(() => readConfigFileSync(filePath), { code: 'EACCES' });
		chmodSync(filePath, 0o644);
		assert.equal(readConfigFileSync(filePath), CONTENTS);
		chmodSync(filePath, 0o000);

		const startedAt = performance.now();
		assert.throws(() => readConfigFileSync(filePath), { code: 'EACCES' });
		const elapsedMs = performance.now() - startedAt;

		assert.ok(elapsedMs >= READ_RETRY_BUDGET_MS * 0.8, `the exhausted deadline outlived the read: ${elapsedMs}ms`);
	});
});
