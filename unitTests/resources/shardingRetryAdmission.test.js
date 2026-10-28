require('../testUtils');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)(
	'Retained sharding retry admission',
	function () {
		this.timeout(30_000);
		const nativeMarkers =
			typeof Transaction.prototype.usesAbortMarkers === 'function' ||
			process.env.HARPER_TEST_ABORT_MARKER_LEGACY_RED === '1';
		for (const mode of ['invalid', 'delete', 'invalidate', 'local-only-put'])
			for (const marker of ['missing', 'false', 'true', 'native'])
				(!nativeMarkers ? it.skip : it)(`${mode} preserves its logged placement (markers=${marker})`, () => {
					const root = mkdtempSync(join(__dirname, '../envDir/slot-admission-'));
					try {
						const output = join(root, 'result.json');
						const child = spawnSync(
							process.execPath,
							[join(__dirname, 'fixtures/slotRetryAdmission.cjs'), mode, marker, root, output],
							{ timeout: 20_000, encoding: 'utf8' }
						);
						assert.equal(child.status, 0, child.stderr);
						const result = JSON.parse(readFileSync(output, 'utf8'));
						if (marker === 'true' || marker === 'native') {
							assert.equal(result.error?.statusCode, 409, JSON.stringify(result));
							assert.equal(result.error.retryable, true);
							assert.match(result.error.message, /slotprobe.RetryRows/);
							assert.match(result.error.message, /retry-probe/);
							assert.equal(result.attempts.filter((id) => id === result.firstId).length, 1);
							assert.deepEqual(result.primary, result.concurrent, 'refused retry leaves primary and indexes unchanged');
							if (marker === 'native')
								assert.ok(
									result.audit.every((e) => e.value?.zone !== 50 && !['delete', 'invalidate'].includes(e.type)),
									'refused entry must be absent from committed log readers'
								);
						} else {
							assert.equal(result.error, undefined, JSON.stringify(result));
							assert.deepEqual(
								result.aborts.filter((e) => e.id === result.firstId),
								[],
								'never abandon the logged handle'
							);
							assert.ok(result.attempts.filter((id) => id === result.firstId).length >= 2);
							assert.equal(result.primary.slot, result.admittedSlot);
							const warnings = result.warnings.filter((w) => w.includes('Logged retry without abort markers'));
							assert.equal(warnings.length, 1, JSON.stringify(warnings));
							assert.match(warnings[0], /slotprobe.RetryRows.*retry-probe/);
							assert.ok(warnings[0].includes('admitted slot ' + result.admittedSlot));
							if (mode === 'invalid') {
								assert.match(warnings[0], /invalid.*50/);
								assert.equal(result.primary.value.zone, 50);
								assert.equal(result.primary.value.body, 'concurrent');
								assert.equal(result.primary.flags & 1, 0);
								assert.ok(result.audit.some((e) => e.type === 'patch' && e.slot === 0 && e.value.zone === 50));
								assert.equal(result.freshError?.statusCode, 400);
							}
						}
					} finally {
						rmSync(root, { recursive: true, force: true });
					}
				});
	}
);
