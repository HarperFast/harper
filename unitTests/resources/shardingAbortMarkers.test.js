require('../testUtils');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
const enabled =
	process.env.HARPER_STORAGE_ENGINE !== 'lmdb' &&
	(typeof Transaction.prototype.usesAbortMarkers === 'function' ||
		process.env.HARPER_TEST_ABORT_MARKER_LEGACY_RED === '1');

(enabled ? describe : describe.skip)('Changed-slot abort markers through startup replay', function () {
	this.timeout(60_000);
	let root, beforeState, afterState;
	before(() => {
		root = mkdtempSync(join(__dirname, '../envDir/slot-markers-'));
		const run = (mode) => {
			const output = join(root, mode + '.json');
			const child = spawnSync(
				process.execPath,
				[join(__dirname, 'fixtures/slotRetryReplay.cjs'), mode, join(root, 'store'), output],
				{ timeout: 30_000, encoding: 'utf8' }
			);
			if (mode === 'write') assert.equal(child.signal, 'SIGKILL', child.stderr);
			else assert.equal(child.status, 0, child.stderr);
			return JSON.parse(readFileSync(output, 'utf8'));
		};
		beforeState = run('write');
		afterState = run('replay');
	});
	after(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});
	it('removes the refused PATCH from committed and startup log readers', () => {
		assert.equal(beforeState.primary.value.zone, 0);
		assert.equal(beforeState.primary.slot, 0);
		for (const entries of [beforeState.committed, beforeState.uncommitted, beforeState.replayTail])
			assert.ok(
				!entries.some((entry) => entry.type === 'patch'),
				'an abandoned PATCH must be invisible to every log reader'
			);
	});
	it('never replays the abandoned PATCH into the primary or indexes after a crash', () => {
		assert.ok(
			afterState.commits.every((commit) => commit.after?.zone !== 1),
			'startup replay must never apply the abandoned PATCH'
		);
		assert.equal(afterState.primary.value.zone, 0);
		assert.equal(afterState.primary.slot, 0);
		assert.deepEqual(afterState.primary.indexes, beforeState.primary.indexes);
	});
});
