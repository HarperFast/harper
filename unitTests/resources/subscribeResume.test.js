const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase } = require('#src/resources/databases');
const {
	getAuditResumeFloor,
	getDatabaseGeneration,
	raiseAuditFloor,
	readAuditEntry,
	stampDatabaseDirectory,
} = require('#src/resources/auditStore');
const {
	ClientError,
	DatabaseGenerationChangedError,
	ResumeHistoryUnavailableError,
} = require('#src/utility/errors/hdbError');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const FLOOR_KEY = Symbol.for('audit-floor');
const RESUME_FLOOR_KEY = Symbol.for('audit-resume-floor');

// what the decoder returns for an entry it cannot read
const corruptEntry = () => readAuditEntry(new Uint8Array(12).fill(0xff));

function floorBytes(value) {
	return new Uint8Array(new Float64Array([value]).buffer);
}

let sequence = 0;
function tableInOwnDatabase(name = `Resume${++sequence}`) {
	return table({
		table: name,
		database: `resume_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
}

function prune(T, before) {
	raiseAuditFloor(T.auditStore, before);
	T.auditStore.rootStore.purgeLogs({ before });
}

async function writeEach(T, count, id = (i) => `r${i}`) {
	const positions = [];
	const live = await T.subscribe({
		omitCurrent: true,
		includeSuperseded: true,
		listener: (event) => positions.push(event.localTime),
	});
	for (let i = 0; i < count; i++) await T.put(id(i), { value: i });
	await waitFor(() => positions.length >= count);
	live.end();
	assert.strictEqual(new Set(positions).size, count, 'precondition: every write has its own log position');
	return positions;
}

async function resume(T, startTime, { onEvent, ...request } = {}) {
	const events = [];
	const subscription = await T.subscribe({
		databaseGeneration: getDatabaseGeneration(T.auditStore).id,
		startTime,
		listener: (event) => {
			events.push(event);
			onEvent?.(event, events);
		},
		...request,
	});
	return { subscription, events };
}

const valuesOf = (events) => events.filter((event) => !(event instanceof Error)).map((event) => event.value?.value);

describe('Resuming a subscription in a database generation', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	describe('a table subscription', () => {
		it('replays everything after the position and verifies it', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 3);
			const { subscription, events } = await resume(T, positions[0]);
			assert.strictEqual(await subscription.resumeVerified, true);
			assert.deepStrictEqual(valuesOf(events), [1, 2]);
			assert.strictEqual(subscription.closed, false, 'a verified resume stays live');
			await T.put('r3', { value: 3 });
			await waitFor(() => valuesOf(events).includes(3));
			subscription.end();
		});

		it('verifies an empty replay from the newest position', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 2);
			const { subscription, events } = await resume(T, positions[1]);
			assert.strictEqual(await subscription.resumeVerified, true);
			assert.deepStrictEqual(events, []);
			subscription.end();
		});

		it('passes a position at the floor and refuses one below it', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 3);
			prune(T, positions[1]);
			assert.strictEqual(getAuditResumeFloor(T.auditStore), positions[1]);
			const { subscription, events } = await resume(T, positions[1]);
			assert.strictEqual(await subscription.resumeVerified, true);
			assert.deepStrictEqual(valuesOf(events), [2]);
			subscription.end();
			await assert.rejects(resume(T, positions[0]), ResumeHistoryUnavailableError);
		});

		it('treats zero as a position', async () => {
			const T = tableInOwnDatabase();
			await writeEach(T, 2);
			await assert.rejects(
				resume(T, 0, { omitCurrent: true }),
				(error) => error instanceof ResumeHistoryUnavailableError && error.statusCode === 410,
				'a database that began after the epoch refuses it like any position below its floor'
			);
			const events = [];
			const unchecked = await T.subscribe({ startTime: 0, omitCurrent: true, listener: (event) => events.push(event) });
			assert.strictEqual(unchecked.resumeVerified, undefined, 'without a generation, zero still means no start');
			assert.deepStrictEqual(events, []);
			unchecked.end();
			// the resume floor of a database whose audit floor was unknown when its generation began
			T.auditStore.putSync(FLOOR_KEY, floorBytes(Infinity));
			T.auditStore.putSync(RESUME_FLOOR_KEY, floorBytes(0));
			assert.strictEqual(getAuditResumeFloor(T.auditStore), 0, 'precondition');
			const fromZero = await resume(T, 0, { omitCurrent: true });
			assert.strictEqual(await fromZero.subscription.resumeVerified, true);
			assert.deepStrictEqual(valuesOf(fromZero.events), [0, 1], 'zero replays the log instead of starting now');
			fromZero.subscription.end();
		});

		it('ends with the 410 when a prune reaches history the replay has not read', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 250);
			const { subscription, events } = await resume(T, positions[0], {
				onEvent: (_event, events) => {
					if (events.length === 1) prune(T, positions[200]);
				},
			});
			assert.strictEqual(await subscription.resumeVerified, false);
			const refusal = events.at(-1);
			assert.ok(refusal instanceof ResumeHistoryUnavailableError, `ended with ${refusal}`);
			assert.strictEqual(refusal.code, 'RESUME_HISTORY_UNAVAILABLE');
			assert.ok(events.length < 200, 'the replay stopped at the first check after the prune');
			assert.strictEqual(subscription.closed, true);
			assert.strictEqual(subscription.subscriptions, null, 'the registry no longer holds it');
			const delivered = events.length;
			await T.put('late', { value: 'late' });
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(events.length, delivered, 'nothing is delivered after the refusal');
		});

		it('still ends a subscription whose listener throws on the refusal', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 250);
			const { subscription } = await resume(T, positions[0], {
				onEvent: (event, events) => {
					if (events.length === 1) prune(T, positions[200]);
					if (event instanceof Error) throw new Error('listener failed on the refusal');
				},
			});
			assert.strictEqual(await subscription.resumeVerified, false);
			assert.strictEqual(subscription.closed, true);
			assert.strictEqual(subscription.subscriptions, null, 'the registry no longer holds it');
		});

		it('verifies a replay when a prune removes only history it has already read', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 250);
			const { subscription, events } = await resume(T, positions[0], {
				onEvent: (_event, events) => {
					if (events.length === 150) prune(T, positions[50]);
				},
			});
			assert.strictEqual(await subscription.resumeVerified, true);
			assert.strictEqual(getAuditResumeFloor(T.auditStore), positions[50], 'precondition: the prune ran mid-replay');
			assert.strictEqual(valuesOf(events).length, 249);
			subscription.end();
		});

		it('checks a yield inside one transaction against that transaction', async () => {
			for (const [coversTransaction, verified] of [
				[false, true],
				[true, false],
			]) {
				const T = tableInOwnDatabase();
				const [cursor] = await writeEach(T, 1);
				await transaction({}, async (context) => {
					for (let i = 0; i < 150; i++) await T.put(`t${i}`, { value: i }, context);
				});
				await T.put('after', { value: 150 });
				const keys = [...T.auditStore.getRange({ start: cursor, exclusiveStart: true })].map(
					(entry) => entry.txnLogKey
				);
				const [transactionKey, after] = [keys[0], keys.at(-1)];
				assert.ok(keys.length === 151 && after > transactionKey, 'precondition: one shared key, then a later one');
				const { subscription, events } = await resume(T, cursor, {
					onEvent: (_event, events) => {
						// past the replay's first yield, which falls inside the transaction
						if (events.length === 120) prune(T, coversTransaction ? (transactionKey + after) / 2 : transactionKey);
					},
				});
				assert.strictEqual(
					await subscription.resumeVerified,
					verified,
					`a prune covering the transaction: ${coversTransaction}`
				);
				if (verified) assert.strictEqual(valuesOf(events).length, 151);
				else assert.ok(events.at(-1) instanceof ResumeHistoryUnavailableError);
				subscription.end();
			}
		});

		it('catches a prune that lands after the first check with no yield in between', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 5);
			// another thread's retention pass, landing once the replay has started reading
			const getRange = T.auditStore.getRange;
			T.auditStore.getRange = function (options) {
				T.auditStore.getRange = getRange;
				prune(T, positions[3]);
				return getRange.call(this, options);
			};
			try {
				const { subscription, events } = await resume(T, positions[0]);
				assert.strictEqual(await subscription.resumeVerified, false);
				assert.ok(events.at(-1) instanceof ResumeHistoryUnavailableError);
			} finally {
				T.auditStore.getRange = getRange;
			}
		});

		it('refuses a replay that crosses a reload, whose back-filled rows have no history', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 2);
			await T.writeReloadMarker();
			await T.put('r2', { value: 2 });
			const { subscription, events } = await resume(T, positions[0]);
			assert.strictEqual(await subscription.resumeVerified, false);
			assert.ok(events.at(-1) instanceof ResumeHistoryUnavailableError);
			assert.match(events.at(-1).message, /bulk reload/);
			const unchecked = [];
			const plain = await T.subscribe({ startTime: positions[0], listener: (event) => unchecked.push(event) });
			await waitFor(() => unchecked.some((event) => event.type === 'reload'));
			assert.ok(
				!unchecked.some((event) => event instanceof Error),
				'a subscription without the field replays as before'
			);
			plain.end();
		});

		it('refuses a replay whose log range recorded a failed read', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 3);
			const getRange = T.auditStore.getRange;
			T.auditStore.getRange = function (options) {
				const range = getRange.call(this, options);
				if (options?.snapshot === false && options.exclusiveStart) {
					T.auditStore.getRange = getRange;
					// what the log store records when it ends a failed log's iteration early
					range.failedLogs.add('unreadable');
				}
				return range;
			};
			try {
				const { subscription, events } = await resume(T, positions[0]);
				assert.strictEqual(await subscription.resumeVerified, false);
				assert.ok(events.at(-1) instanceof ResumeHistoryUnavailableError);
				assert.match(events.at(-1).message, /could not be read/);
			} finally {
				T.auditStore.getRange = getRange;
			}
		});

		for (const [name, damage] of [
			['an entry that fails to decode', () => corruptEntry()],
			['an entry whose record id fails to decode', (entry) => Object.create(entry, { recordId: { value: undefined } })],
		]) {
			it(`refuses a replay across ${name}`, async () => {
				const T = tableInOwnDatabase();
				const positions = await writeEach(T, 3);
				assert.strictEqual(corruptEntry().type, undefined, 'precondition: the decoder returns its sentinel');
				const getRange = T.auditStore.getRange;
				T.auditStore.getRange = function (options) {
					const range = getRange.call(this, options);
					if (!(options?.snapshot === false && options.exclusiveStart)) return range;
					T.auditStore.getRange = getRange;
					return (function* () {
						let damaged = false;
						for (const entry of range) {
							if (!damaged && entry.tableId === T.tableId) {
								damaged = true;
								yield damage(entry);
							} else yield entry;
						}
					})();
				};
				try {
					const { subscription, events } = await resume(T, positions[0]);
					assert.strictEqual(await subscription.resumeVerified, false);
					assert.ok(events.at(-1) instanceof ResumeHistoryUnavailableError);
					assert.match(events.at(-1).message, /could not be read/);
				} finally {
					T.auditStore.getRange = getRange;
				}
			});
		}

		it('delivers the refusal as the last iterated value', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 250);
			const subscription = await T.subscribe({
				databaseGeneration: getDatabaseGeneration(T.auditStore).id,
				startTime: positions[0],
			});
			prune(T, positions[240]);
			const received = [];
			for await (const event of subscription) received.push(event);
			assert.ok(received.at(-1) instanceof ResumeHistoryUnavailableError);
			assert.strictEqual(await subscription.resumeVerified, false);
		});

		it('settles the verdict false when the subscription ends mid-replay', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 250);
			const { subscription, events } = await resume(T, positions[0]);
			subscription.end();
			assert.strictEqual(await subscription.resumeVerified, false);
			assert.ok(events.length < 249, 'precondition: it ended before the replay finished');
		});

		it('settles the verdict false when a listener fails during the replay', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 3);
			const { subscription } = await resume(T, positions[0], {
				onEvent: (event) => {
					if (!(event instanceof Error)) throw new Error('listener failed');
				},
			});
			assert.strictEqual(await subscription.resumeVerified, false);
			assert.strictEqual(subscription.closed, true);
		});
	});

	describe('a record subscription', () => {
		it('replays the versions after the position and verifies them', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 4, () => 'A');
			const { subscription, events } = await resume(T, positions[0], { id: 'A', includeSuperseded: true });
			assert.strictEqual(await subscription.resumeVerified, true);
			assert.deepStrictEqual(valuesOf(events), [1, 2, 3]);
			subscription.end();
		});

		it('verifies a record with no versions after the position, whatever the floor', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 2, () => 'A');
			prune(T, positions[1] + 1);
			const { subscription, events } = await resume(T, positions[1], { id: 'A', omitCurrent: true });
			assert.strictEqual(await subscription.resumeVerified, true, 'nothing about the record changed after it');
			assert.deepStrictEqual(events, []);
			subscription.end();
		});

		it('verifies a walk that finds every version, though the floor passed the position', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 300, () => 'A');
			const pending = resume(T, positions[0], { id: 'A', includeSuperseded: true });
			setImmediate(() => prune(T, positions[250]));
			const { subscription, events } = await pending;
			assert.strictEqual(await subscription.resumeVerified, true);
			assert.ok(getAuditResumeFloor(T.auditStore) > positions[0], 'precondition: the floor passed the position');
			assert.strictEqual(valuesOf(events).length, 299);
			subscription.end();
		});

		it('sends none of the history when a version is missing from the walk', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 300, () => 'A');
			const getSync = T.auditStore.getSync;
			T.auditStore.getSync = function (key, ...rest) {
				return key === positions[150] ? undefined : getSync.call(this, key, ...rest);
			};
			try {
				const { subscription, events } = await resume(T, positions[0], { id: 'A', includeSuperseded: true });
				assert.strictEqual(await subscription.resumeVerified, false);
				assert.strictEqual(events.length, 1, 'only the refusal');
				assert.ok(events[0] instanceof ResumeHistoryUnavailableError);
			} finally {
				T.auditStore.getSync = getSync;
			}
		});

		it('checks the floor when a walk ends at a first version, which a recreation after tombstone cleanup starts', async () => {
			const T = tableInOwnDatabase();
			const [cursor] = await writeEach(T, 1, () => 'A');
			await T.delete('A');
			const deleteKey = [...T.auditStore.getRange({ start: cursor, exclusiveStart: true })].at(-1).txnLogKey;
			await T.put('B', { value: 'first' });
			const created = await resume(T, cursor, { id: 'B', includeSuperseded: true });
			assert.strictEqual(await created.subscription.resumeVerified, true, 'a record first written after the cursor');
			assert.deepStrictEqual(valuesOf(created.events), ['first'], 'replayed from its first version');
			created.subscription.end();
			// retention prunes the delete, and cleanup takes the tombstone with it
			prune(T, deleteKey + 0.001);
			const tombstone = T.primaryStore.getEntry('A');
			await T.auditStore.deleteCallbacks[T.tableId]('A', tombstone.version);
			assert.strictEqual(T.primaryStore.getEntry('A'), undefined, 'precondition: the tombstone is gone');
			await T.put('A', { value: 'again' });
			const { subscription, events } = await resume(T, cursor, { id: 'A', includeSuperseded: true });
			assert.strictEqual(await subscription.resumeVerified, false, 'the delete between is gone, and nothing says so');
			assert.strictEqual(events.length, 1);
			assert.ok(events[0] instanceof ResumeHistoryUnavailableError);
		});

		it('refuses a walk that reads a version it cannot decode', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 5, () => 'A');
			const getSync = T.auditStore.getSync;
			T.auditStore.getSync = function (key, ...rest) {
				return key === positions[2] ? corruptEntry() : getSync.call(this, key, ...rest);
			};
			try {
				const { subscription, events } = await resume(T, positions[0], { id: 'A', includeSuperseded: true });
				assert.strictEqual(await subscription.resumeVerified, false);
				assert.strictEqual(events.length, 1, 'only the refusal');
				assert.ok(events[0] instanceof ResumeHistoryUnavailableError);
			} finally {
				T.auditStore.getSync = getSync;
			}
		});

		it('checks the floor for a record with no entry, which a pruned tombstone may have taken', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 2);
			const { subscription } = await resume(T, positions[1], { id: 'absent', omitCurrent: true });
			assert.strictEqual(await subscription.resumeVerified, true);
			subscription.end();
			// an instance that is not preloaded reads its record inside subscribe, after the first check
			class Unloaded extends T {
				static loadAsInstance = false;
			}
			const getEntry = T.primaryStore.getEntry;
			let pruned = false;
			T.primaryStore.getEntry = function (...args) {
				T.primaryStore.getEntry = getEntry;
				pruned = true;
				prune(T, positions[1] + 1);
				return getEntry.apply(this, args);
			};
			try {
				const refused = await resume(Unloaded, positions[1], { id: 'absent' });
				assert.ok(pruned, 'precondition: the prune landed after the first check');
				assert.strictEqual(await refused.subscription.resumeVerified, false);
				assert.strictEqual(refused.events.length, 1);
				assert.ok(refused.events[0] instanceof ResumeHistoryUnavailableError);
			} finally {
				T.primaryStore.getEntry = getEntry;
			}
		});

		it('refuses to certify a walk its version cap cut short', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 10_002, () => 'A');
			const { subscription, events } = await resume(T, positions[0], { id: 'A' });
			assert.strictEqual(await subscription.resumeVerified, false);
			assert.strictEqual(events.length, 1, 'no partial history');
			assert.ok(events[0] instanceof ResumeHistoryUnavailableError);
			assert.match(events[0].message, /More than 10000 versions/);
			const short = await resume(T, positions[1], { id: 'A', omitCurrent: true });
			assert.strictEqual(await short.subscription.resumeVerified, true, 'exactly at the cap still verifies');
			short.subscription.end();
		});
	});

	describe('refusals before registering', () => {
		it('refuses an unknown generation, and a generation the database was copied from', async () => {
			const name = 'ResumeReplaced';
			const T = tableInOwnDatabase(name);
			const positions = await writeEach(T, 2);
			const previous = getDatabaseGeneration(T.auditStore).id;
			for (const id of [undefined, 'r0']) {
				await assert.rejects(
					resume(T, positions[0], { id, databaseGeneration: 'ab'.repeat(16) }),
					(error) => error instanceof DatabaseGenerationChangedError && error.statusCode === 409,
					`id ${id}`
				);
			}
			const path = T.auditStore.rootStore.path;
			assert.ok(await closeDatabase(`resume_${name}`));
			await stampDatabaseDirectory(path, { carriesLog: true });
			const copy = tableInOwnDatabase(name);
			assert.notStrictEqual(getDatabaseGeneration(copy.auditStore).id, previous);
			await assert.rejects(
				resume(copy, positions[0], { databaseGeneration: previous }),
				DatabaseGenerationChangedError
			);
		});

		it('requires a finite startTime and no previousCount', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 1);
			for (const startTime of [undefined, NaN, Infinity, String(positions[0])]) {
				await assert.rejects(
					resume(T, startTime),
					(error) => error instanceof ClientError && error.statusCode === 400,
					`startTime ${startTime}`
				);
			}
			for (const previousCount of [0, 2]) {
				await assert.rejects(
					resume(T, positions[0], { id: 'r0', previousCount }),
					ClientError,
					`previousCount ${previousCount}`
				);
			}
		});

		it('leaves a subscription without a generation unchecked', async () => {
			const T = tableInOwnDatabase();
			const positions = await writeEach(T, 3);
			prune(T, positions[2]);
			const events = [];
			const subscription = await T.subscribe({ startTime: positions[0], listener: (event) => events.push(event) });
			assert.strictEqual(subscription.resumeVerified, undefined);
			await waitFor(() => valuesOf(events).includes(2));
			assert.ok(!events.some((event) => event instanceof Error));
			subscription.end();
		});
	});

	describe('across a generation change', () => {
		it('settles the verdict false when the database is replaced mid-replay', async () => {
			const name = 'ResumeMidReplay';
			const T = tableInOwnDatabase(name);
			const positions = await writeEach(T, 250);
			const { subscription, events } = await resume(T, positions[0]);
			const path = T.auditStore.rootStore.path;
			assert.ok(await closeDatabase(`resume_${name}`));
			await stampDatabaseDirectory(path, { carriesLog: true });
			tableInOwnDatabase(name);
			assert.strictEqual(await subscription.resumeVerified, false);
			assert.strictEqual(subscription.closed, true);
			assert.ok(events.at(-1) instanceof Error, 'the replay reading the closed handle ends it');
			assert.ok(events.length < 250, 'precondition: it ended before the replay finished');
		});
	});

	it('reports the generation a subscription reads', async () => {
		const T = tableInOwnDatabase();
		const subscription = await T.subscribe({ omitCurrent: true });
		assert.strictEqual(subscription.databaseGeneration, getDatabaseGeneration(T.auditStore).id);
		subscription.end();
	});
});

describe('Resuming a subscription in a database generation on LMDB', () => {
	if (isRocksDB) return;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('refuses every resume, since LMDB has no generation', async () => {
		const T = tableInOwnDatabase();
		await T.put('A', { value: 1 });
		await assert.rejects(
			T.subscribe({ databaseGeneration: 'ab'.repeat(16), startTime: Date.now(), omitCurrent: true }),
			(error) => error instanceof DatabaseGenerationChangedError && error.statusCode === 409
		);
		const subscription = await T.subscribe({ omitCurrent: true });
		assert.strictEqual(subscription.databaseGeneration, undefined);
		assert.strictEqual(subscription.resumeVerified, undefined);
		subscription.end();
	});
});
