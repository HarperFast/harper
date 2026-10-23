'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DiskLedger, defaultReserve, ledgerMeter } = require('#src/dataLayer/diskLedger');

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** A controllable volume: `available` and `updatedAt` are what the next stats call reports. */
function fakeVolume({ available = 10_000_000, updatedAt = 1000, basis = 'quota', bsize = 4096, files, ffree } = {}) {
	const volume = {
		available,
		updatedAt,
		basis,
		bsize,
		files: files ?? 1_000_000,
		ffree: ffree ?? 1_000_000,
		statsCalls: 0,
		stats: async () => {
			volume.statsCalls++;
			return {
				available: volume.available,
				free: volume.available,
				size: 100_000_000,
				basis: volume.basis,
				updatedAt: volume.updatedAt,
			};
		},
		statfs: () => ({ bsize: volume.bsize, files: volume.files, ffree: volume.ffree }),
	};
	return volume;
}

function ledgerFor(volume, options = {}) {
	const clock = { now: 2000 };
	const ledger = new DiskLedger({
		stats: volume.stats,
		statfs: volume.statfs,
		deviceOf: () => 1,
		reserve: () => 0,
		inodeReserve: () => 0,
		now: () => clock.now,
		...options,
	});
	return { ledger, clock };
}

async function assertInsufficient(promise, pathFragment) {
	await assert.rejects(promise, (error) => {
		assert.strictEqual(error.statusCode, 507);
		assert.ok(error.message.includes(pathFragment), `message must name the path: ${error.message}`);
		return true;
	});
}

describe('DiskLedger', function () {
	it('charges a file in whole allocation blocks of the device', async function () {
		const volume = fakeVolume({ bsize: 65536 });
		const { ledger } = ledgerFor(volume);
		assert.strictEqual(await ledger.debitEntry('/staging/a', 1), 65536);
		assert.strictEqual(await ledger.debitEntry('/staging/b', 65536), 65536);
		assert.strictEqual(await ledger.debitEntry('/staging/c', 65537), 131072);
		assert.strictEqual(await ledger.debitEntry('/staging/d', 0), 0);
		const remaining = await ledger.remaining('/staging');
		assert.strictEqual(remaining.bytes, 10_000_000 - 65536 * 4);
		assert.strictEqual(remaining.inodes, 1_000_000 - 4);
	});

	it('charges a directory one block and one inode', async function () {
		const volume = fakeVolume({ bsize: 4096 });
		const { ledger } = ledgerFor(volume);
		assert.strictEqual(await ledger.debitDirectory('/staging/dir'), 4096);
		const remaining = await ledger.remaining('/staging');
		assert.strictEqual(remaining.bytes, 10_000_000 - 4096);
		assert.strictEqual(remaining.inodes, 1_000_000 - 1);
	});

	it('refuses with 507 naming the path when a debit crosses the budget, charging nothing', async function () {
		const volume = fakeVolume({ available: 10_000 });
		const { ledger } = ledgerFor(volume);
		await ledger.debit('/staging/x', 6000);
		await assertInsufficient(ledger.debit('/staging/y', 6000), '/staging/y');
		assert.strictEqual((await ledger.remaining('/staging')).bytes, 4000);
		await ledger.debit('/staging/z', 4000);
	});

	it('keeps the reserve out of the budget, by default max(1 GiB, 5% of size)', async function () {
		assert.strictEqual(defaultReserve({ size: 10 * GIB }), GIB);
		assert.strictEqual(defaultReserve({ size: 100 * GIB }), 5 * GIB);
		const volume = fakeVolume({ available: 10_000 });
		const { ledger } = ledgerFor(volume, { reserve: () => 3000 });
		await assertInsufficient(ledger.debit('/staging/x', 7001), '/staging/x');
		await ledger.debit('/staging/x', 7000);
	});

	it('keeps one budget per device, not per path', async function () {
		const staging = fakeVolume({ available: 10_000 });
		const repository = fakeVolume({ available: 10_000 });
		const ledger = new DiskLedger({
			stats: (path) => (path.startsWith('/mnt') ? staging : repository).stats(path),
			statfs: (path) => (path.startsWith('/mnt') ? staging : repository).statfs(path),
			deviceOf: (path) => (path.startsWith('/mnt') ? 2 : 1),
			reserve: () => 0,
			inodeReserve: () => 0,
		});
		await ledger.debit('/mnt/import/a', 9000);
		await ledger.debit('/backups/db/b', 9000);
		await ledger.debit('/backups/db/elsewhere/c', 1000);
		await assertInsufficient(ledger.debit('/backups/db/d', 1), '/backups/db/d');
		await assertInsufficient(ledger.debit('/mnt/import/e', 1001), '/mnt/import/e');
	});

	it('groups a not-yet-created path with the volume of its nearest existing ancestor', async function () {
		const dir = mkdtempSync(join(tmpdir(), 'harper.unit-test.disk-ledger-'));
		try {
			const volume = fakeVolume({ available: 10_000 });
			const ledger = new DiskLedger({
				stats: volume.stats,
				statfs: volume.statfs,
				reserve: () => 0,
				inodeReserve: () => 0,
			});
			await ledger.debit(dir, 6000);
			await assertInsufficient(ledger.debit(join(dir, 'not', 'yet', 'created'), 6000), 'created');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe('stale samples', function () {
		it('does not re-base on a frozen quota sample, however often it is re-read', async function () {
			const volume = fakeVolume({ available: 10_000, updatedAt: 1000 });
			const { ledger, clock } = ledgerFor(volume, { resampleIntervalMs: 1 });
			for (let i = 0; i < 9; i++) {
				clock.now += 100;
				await ledger.debit('/staging/x', 1000);
			}
			assert.ok(volume.statsCalls >= 9, 'the time throttle should have re-read the sample');
			clock.now += 100;
			await assertInsufficient(ledger.debit('/staging/x', 1001), '/staging/x');
		});

		it('re-bases on a sample measured after the last debit', async function () {
			const volume = fakeVolume({ available: 10_000, updatedAt: 1000 });
			const { ledger, clock } = ledgerFor(volume, { resampleIntervalMs: 1000 });
			await ledger.debit('/staging/x', 9000);
			clock.now += 500;
			volume.updatedAt = clock.now;
			volume.available = 50_000;
			clock.now += 1000;
			await ledger.debit('/staging/x', 40_000);
			assert.strictEqual((await ledger.remaining('/staging')).bytes, 10_000);
		});

		it('does not re-base on a newer sample that predates the last debit', async function () {
			const volume = fakeVolume({ available: 10_000, updatedAt: 1000 });
			const { ledger, clock } = ledgerFor(volume, { resampleIntervalMs: 1000 });
			clock.now = 3000;
			await ledger.debit('/staging/x', 9000);
			// newer than the first sample, but measured before the 9000 bytes were charged
			volume.updatedAt = 2500;
			volume.available = 10_000;
			clock.now = 5000;
			await assertInsufficient(ledger.debit('/staging/x', 1001), '/staging/x');
			assert.strictEqual((await ledger.remaining('/staging')).bytes, 1000);
		});

		it('re-samples before refusing, so space freed since the last sample is seen', async function () {
			const volume = fakeVolume({ available: 10_000, updatedAt: 1000 });
			const { ledger, clock } = ledgerFor(volume, { resampleIntervalMs: 60_000 });
			await ledger.debit('/staging/x', 9000);
			clock.now += 10;
			volume.updatedAt = clock.now;
			volume.available = 30_000;
			clock.now += 10;
			await ledger.debit('/staging/x', 20_000);
		});
	});

	describe('re-sample throttling', function () {
		it('re-reads stats only after the byte threshold, not per debit', async function () {
			const volume = fakeVolume({ available: 1_000_000 });
			const { ledger } = ledgerFor(volume, { resampleBytes: 10_000, resampleIntervalMs: Infinity });
			for (let i = 0; i < 100; i++) await ledger.debit('/staging/x', 1000);
			// one initial sample, then one per 10,000 bytes charged
			assert.ok(volume.statsCalls >= 9 && volume.statsCalls <= 11, `stats read ${volume.statsCalls} times`);
		});

		it('re-reads stats only after the time threshold, not per debit', async function () {
			const volume = fakeVolume({ available: 1_000_000 });
			const { ledger, clock } = ledgerFor(volume, { resampleBytes: Infinity, resampleIntervalMs: 1000 });
			for (let i = 0; i < 100; i++) {
				clock.now += 100;
				await ledger.debit('/staging/x', 1);
			}
			assert.ok(volume.statsCalls >= 9 && volume.statsCalls <= 11, `stats read ${volume.statsCalls} times`);
		});
	});

	describe('reserve', function () {
		it('refuses a planned peak before anything is written', async function () {
			const volume = fakeVolume({ available: 10_000 });
			const { ledger } = ledgerFor(volume);
			let wrote = false;
			await assertInsufficient(
				ledger.reserve('/backups/db', 20_000).then(() => {
					wrote = true;
				}),
				'/backups/db'
			);
			assert.strictEqual(wrote, false);
			assert.strictEqual((await ledger.remaining('/backups/db')).bytes, 10_000);
		});

		it('holds the reservation across a re-base until released', async function () {
			const volume = fakeVolume({ available: 10_000, updatedAt: 1000 });
			const { ledger, clock } = ledgerFor(volume, { resampleIntervalMs: 1 });
			const hold = await ledger.reserve('/backups/db', 8000);
			clock.now += 10;
			// a sample taken mid-write: only part of the planned bytes have landed
			volume.updatedAt = clock.now;
			volume.available = 7000;
			clock.now += 10;
			await assertInsufficient(ledger.debit('/backups/db/x', 1), '/backups/db/x');
			hold.release(5000);
			assert.strictEqual((await ledger.remaining('/backups/db')).bytes, 2000);
			hold.release();
			assert.strictEqual((await ledger.remaining('/backups/db')).bytes, 2000, 'a second release is a no-op');
		});
	});

	describe('inodes', function () {
		it('refuses when entries would exhaust free inodes, with bytes to spare', async function () {
			const volume = fakeVolume({ available: 1_000_000_000, files: 1000, ffree: 3 });
			const { ledger } = ledgerFor(volume);
			await ledger.debitEntry('/staging/a', 0);
			await ledger.debitDirectory('/staging/b');
			await ledger.debitEntry('/staging/c', 0);
			await assert.rejects(ledger.debitEntry('/staging/d', 0), (error) => {
				assert.strictEqual(error.statusCode, 507);
				assert.match(error.message, /inodes/);
				return true;
			});
		});

		it('treats a filesystem with no fixed inode table (files = 0) as unbounded', async function () {
			const volume = fakeVolume({ available: 1_000_000_000, files: 0, ffree: 0 });
			const { ledger } = ledgerFor(volume, { inodeReserve: () => 1000 });
			for (let i = 0; i < 10; i++) await ledger.debitEntry('/staging/a', 0);
		});
	});

	describe('ledgerMeter', function () {
		/** A ledger whose debits are recorded, so a test sees how often the meter consults it. */
		function countedLedger(volume) {
			const { ledger } = ledgerFor(volume);
			const debits = [];
			const debit = ledger.debit.bind(ledger);
			ledger.debit = (path, bytes, inodes) => {
				debits.push(bytes);
				return debit(path, bytes, inodes);
			};
			return { ledger, debits };
		}

		async function meterThrough(meter, chunks) {
			let carried = 0;
			await pipeline(
				Readable.from(chunks),
				meter,
				new Writable({
					write(chunk, _encoding, callback) {
						carried += chunk.length;
						callback();
					},
				})
			);
			return carried;
		}

		it('charges in batches rather than per chunk, and flushes the remainder', async function () {
			const volume = fakeVolume({ available: 1 * GIB });
			const { ledger, debits } = countedLedger(volume);
			const chunks = Array.from({ length: 20 * 16 }, () => Buffer.alloc(64 * 1024));
			const seen = [];
			const carried = await meterThrough(
				ledgerMeter(ledger, '/staging/archive', { onChunk: (chunk) => seen.push(chunk.length) }),
				chunks
			);
			assert.strictEqual(carried, 20 * MIB, 'every byte passes through');
			assert.strictEqual(seen.length, chunks.length, 'onChunk sees every chunk');
			assert.deepStrictEqual(debits, [8 * MIB, 8 * MIB, 4 * MIB], 'two full batches, then the remainder');
			assert.strictEqual((await ledger.remaining('/staging')).bytes, 1 * GIB - 20 * MIB);
		});

		it('charges a stream smaller than one batch once, at its end', async function () {
			const volume = fakeVolume({ available: 1 * GIB });
			const { ledger, debits } = countedLedger(volume);
			await meterThrough(ledgerMeter(ledger, '/staging/archive'), [Buffer.alloc(1000), Buffer.alloc(24)]);
			assert.deepStrictEqual(debits, [1024]);
		});

		it('fails the stream with 507 once a batch crosses the budget', async function () {
			const volume = fakeVolume({ available: 12 * MIB });
			const { ledger } = countedLedger(volume);
			const chunks = Array.from({ length: 32 }, () => Buffer.alloc(1 * MIB));
			await assert.rejects(meterThrough(ledgerMeter(ledger, '/staging/archive'), chunks), (error) => {
				assert.strictEqual(error.statusCode, 507);
				assert.match(error.message, /\/staging\/archive/);
				return true;
			});
		});

		it('destroys a stream that stops delivering with 504, and arms no timer without idleMs', async function () {
			const volume = fakeVolume({ available: 1 * GIB });
			const { ledger } = countedLedger(volume);
			const stalled = ledgerMeter(ledger, '/staging/archive', { idleMs: 50 });
			stalled.write(Buffer.alloc(10));
			const [error] = await once(stalled, 'error');
			assert.strictEqual(error.statusCode, 504);
			assert.match(error.message, /No data arrived for 50ms/);

			const patient = ledgerMeter(ledger, '/staging/archive');
			patient.on('error', (unexpected) => assert.fail(unexpected));
			patient.write(Buffer.alloc(10));
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.strictEqual(patient.destroyed, false);
			patient.destroy();
		});

		it('keeps a stream alive while data keeps arriving within idleMs', async function () {
			const volume = fakeVolume({ available: 1 * GIB });
			const { ledger } = countedLedger(volume);
			async function* trickle() {
				// each gap well inside idleMs, the whole stream well past it
				for (let i = 0; i < 5; i++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					yield Buffer.alloc(10);
				}
			}
			assert.strictEqual(await meterThrough(ledgerMeter(ledger, '/staging/archive', { idleMs: 300 }), trickle()), 50);
		});
	});
});
