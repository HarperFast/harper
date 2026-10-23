const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { existsSync } = require('node:fs');
const { waitFor } = require('../waitFor');
const { certifyOriginFloor, publishOriginFloor } = require('#src/resources/originClosedFloor');
const {
	persistOriginClosedFloor,
	raiseAuditFloor,
	createAuditEntry,
	HAS_ADDITIONAL_AUDIT_REFS,
} = require('#src/resources/auditStore');
const { getFileId, getFilePathForBlob, isSaving, setDeletionDelay } = require('#src/resources/blob');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

function permutations(values) {
	if (values.length === 0) return [[]];
	return values.flatMap((value, index) =>
		permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest])
	);
}

let nextTimestamp = Date.now() + 1_000_000;

const cases = [
	{
		name: 'removes omitted fields and preserves newer sets and additions',
		lmdbVersionRegressionOrders: ['201'],
		writes: [
			['put', { a: 'v0', b: 'v0', c: 'stale', counter: 10 }],
			['put', { a: 'v1-put', b: 'v1-put', counter: 100 }],
			['patch', { b: 'v2-patch', counter: { __op__: 'add', value: 5 } }],
		],
		expected: { a: 'v1-put', b: 'v2-patch', counter: 105 },
	},
	{
		name: 'preserves newer-only fields and adds onto an omitted field',
		lmdbVersionRegressionOrders: ['201'],
		writes: [
			['put', { a: 'old', c: 'stale', counter: 10 }],
			['put', { a: 'replacement' }],
			['patch', { b: 'introduced', counter: { __op__: 'add', value: 5 } }],
		],
		expected: { a: 'replacement', b: 'introduced', counter: 5 },
	},
	{
		name: 'replays multiple newer patches chronologically',
		lmdbVersionRegressionOrders: ['0312', '2013', '2031', '2301', '3012', '3021', '3102', '3120', '3201'],
		writes: [
			['put', { c: 'stale', counter: 10 }],
			['put', { a: 'replacement', counter: 100 }],
			['patch', { b: 'first', counter: { __op__: 'add', value: 5 } }],
			['patch', { b: 'last', counter: { __op__: 'add', value: 7 } }],
		],
		expected: { a: 'replacement', b: 'last', counter: 112 },
	},
	{
		name: 'replaces with an empty body before applying newer patches',
		lmdbVersionRegressionOrders: ['201'],
		writes: [
			['put', { c: 'stale', counter: 10 }],
			['put', {}],
			['patch', { b: 'introduced', counter: { __op__: 'add', value: 5 } }],
		],
		expected: { b: 'introduced', counter: 5 },
	},
	{
		name: 'lets a newer full PUT supersede all older writes',
		writes: [
			['put', { c: 'stale', counter: 10 }],
			['patch', { b: 'patch', counter: { __op__: 'add', value: 5 } }],
			['put', { a: 'newest' }],
		],
		expected: { a: 'newest' },
	},
];

for (const loadAsInstance of [true, false]) {
	describe(`Out-of-order full PUT replacement (loadAsInstance=${loadAsInstance}, harper#3404)`, () => {
		let T;

		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
			T = table({
				table: `FullPut${loadAsInstance}`,
				database: 'outOfOrderFullPut',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'c', indexed: true },
				],
				audit: true,
			});
			T.loadAsInstance = loadAsInstance;
		});

		for (const [caseIndex, { name, writes, expected, lmdbVersionRegressionOrders = [] }] of cases.entries()) {
			for (const order of permutations(writes.map((_, index) => index))) {
				// These orders hit the independent LMDB entry.version regression (#3388).
				const test = isLMDB && lmdbVersionRegressionOrders.includes(order.join('')) ? it.skip : it;
				test(`${name}: arrival ${order.join(',')}`, async () => {
					const id = `${caseIndex}-${order.join('-')}`;
					const timestamp = (nextTimestamp += 1000);
					for (const index of order) {
						const [method, value] = writes[index];
						await T[method](id, structuredClone(value), { timestamp: timestamp + index });
					}
					assert.deepStrictEqual({ ...(await T.get(id)) }, { id, ...expected });
					assert.deepStrictEqual({ ...T.primaryStore.getEntry(id).value }, { id, ...expected });
					for await (const record of T.search({
						conditions: [{ attribute: 'c', comparator: 'equals', value: 'stale' }],
					}))
						assert.notStrictEqual(record.id, id);
				});
			}
		}
	});

	describe(`Retained history boundaries (loadAsInstance=${loadAsInstance})`, () => {
		let T;
		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
			T = table({
				table: `Boundaries${loadAsInstance}`,
				database: 'fullPutBoundaries',
				attributes: [{ name: 'id', isPrimaryKey: true }],
				audit: true,
			});
			T.loadAsInstance = loadAsInstance;
		});

		it('preserves uncollected newer fields when the audit walk reaches its depth cap', async function () {
			if (isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 100_000);
			nextTimestamp += 2000;
			await T.put('capped', { c: 'old' }, { timestamp });
			await T.patch('capped', { early: 'newer' }, { timestamp: timestamp + 10 });
			for (let i = 1; i <= 1010; i++) {
				await T.patch('capped', { seq: i }, { timestamp: timestamp + 10 + i });
			}
			await T.put('capped', { a: 'replacement' }, { timestamp: timestamp + 5 });
			assert.deepStrictEqual(
				{ ...(await T.get('capped')) },
				{
					id: 'capped',
					c: 'old',
					early: 'newer',
					seq: 1010,
					a: 'replacement',
				}
			);
		});

		it('preserves uncollected newer fields when an audit entry is missing', async function () {
			if (!isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 1000);
			await T.put('missing', { c: 'old' }, { timestamp });
			await T.patch('missing', { early: 'newer' }, { timestamp: timestamp + 10 });
			const middle = [...T.auditStore.getRange({ start: 0, end: Infinity })].find(
				(entry) => entry.recordId === 'missing' && entry.version === timestamp + 10
			);
			assert.ok(middle);
			await T.patch('missing', { latest: 'newest' }, { timestamp: timestamp + 20 });
			await T.auditStore.remove(middle.key);
			assert.equal(T.auditStore.get(middle.txnLogKey, T.tableId, 'missing'), undefined);
			await T.put('missing', { a: 'replacement' }, { timestamp: timestamp + 5 });
			assert.deepStrictEqual(
				{ ...(await T.get('missing')) },
				{
					id: 'missing',
					c: 'old',
					early: 'newer',
					latest: 'newest',
					a: 'replacement',
				}
			);
		});

		it('replaces across a backdated newer patch whose receipt has no audit entry', async function () {
			if (isLMDB) return this.skip();
			const timestamp = Date.now();
			await T.put('rekeyed', { a: 'old', c: 'stale' }, { timestamp });
			let floor;
			await waitFor(
				() => {
					floor = certifyOriginFloor(T.primaryStore.rootStore);
					return floor && floor > timestamp + 20;
				},
				{ timeout: 5000, message: 'the origin floor did not advance past the newer patch' }
			);
			persistOriginClosedFloor(T.auditStore, floor);
			publishOriginFloor(T.primaryStore.rootStore, floor);
			await T.patch('rekeyed', { b: 'newer' }, { timestamp: timestamp + 20 });
			const entry = T.primaryStore.getEntry('rekeyed');
			assert.ok(entry.additionalAuditRefs.some((ref) => ref.version === timestamp + 20));
			assert.equal(T.auditStore.get(timestamp + 20, T.tableId, 'rekeyed', 0), undefined);
			await T.put('rekeyed', { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await T.get('rekeyed')) },
				{
					id: 'rekeyed',
					a: 'replacement',
					b: 'newer',
				}
			);
		});

		it('keeps the merge for a missing receipt when prior retention is unknown', async function () {
			if (isLMDB) return this.skip();
			const Unknown = table({
				table: 'UnknownHistory',
				database: `unknownPutHistory${loadAsInstance}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			Unknown.loadAsInstance = loadAsInstance;
			const timestamp = Date.now();
			await Unknown.put('unknown', { c: 'retained' }, { timestamp });
			let floor;
			await waitFor(() => {
				floor = certifyOriginFloor(Unknown.primaryStore.rootStore);
				return floor && floor > timestamp + 20;
			});
			persistOriginClosedFloor(Unknown.auditStore, floor);
			publishOriginFloor(Unknown.primaryStore.rootStore, floor);
			await Unknown.patch('unknown', { b: 'newer' }, { timestamp: timestamp + 20 });
			raiseAuditFloor(Unknown.auditStore, Infinity);
			await Unknown.put('unknown', { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await Unknown.get('unknown')) },
				{ id: 'unknown', c: 'retained', b: 'newer', a: 'replacement' }
			);
		});

		it('applies an empty PUT on a keyless table beneath newer patches', async () => {
			const Keyless = table({
				table: `Keyless${loadAsInstance}`,
				database: 'fullPutBoundaries',
				audit: true,
				schemaDefined: true,
				attributes: [
					{ name: 'sequence', type: 'Int' },
					{ name: 'stale', type: 'String' },
				],
			});
			Keyless.loadAsInstance = loadAsInstance;
			const timestamp = (nextTimestamp += 2000);
			nextTimestamp += 2000;
			await Keyless.put('keyless', { stale: 'old' }, { timestamp });
			const patchCount = isLMDB ? 2 : 999;
			for (let index = 1; index <= patchCount; index++) {
				await Keyless.patch('keyless', { sequence: index }, { timestamp: timestamp + index + 1 });
			}
			await Keyless.put('keyless', {}, { timestamp: timestamp + 1 });
			assert.deepStrictEqual({ ...(await Keyless.get('keyless')) }, { sequence: patchCount });
		});

		it('replays every newer same-key patch within one transaction', async () => {
			const timestamp = (nextTimestamp += 1000);
			await T.put('frame', { c: 'stale', counter: 10 }, { timestamp });
			const context = { timestamp: timestamp + 20 };
			await transaction(context, async () => {
				await T.patch('frame', { b: 'first', first: true, counter: { __op__: 'add', value: 5 } }, context);
				await T.publish(null, { message: 'root topic' }, context);
				await T.patch('frame', { b: 'last', d: 'second', counter: { __op__: 'add', value: 7 } }, context);
			});
			await T.put('frame', { a: 'replacement', counter: 100 }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await T.get('frame')) },
				{
					id: 'frame',
					a: 'replacement',
					b: 'last',
					first: true,
					d: 'second',
					counter: 112,
				}
			);
		});

		it('retains fields beyond the transaction scan budget', async () => {
			const timestamp = (nextTimestamp += 100_000);
			nextTimestamp += 2000;
			await T.put('large-frame', { c: 'stale' }, { timestamp });
			const context = { timestamp: timestamp + 20 };
			await transaction(context, async () => {
				await T.patch('large-frame', { b: 'first' }, context);
				for (let index = 0; index < 1005; index++) {
					await T.put(`unrelated-${index}`, { value: index }, context);
				}
				await T.patch('large-frame', { d: 'last' }, context);
			});
			await T.put('large-frame', { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await T.get('large-frame')) },
				{ id: 'large-frame', c: 'stale', b: 'first', d: 'last', a: 'replacement' }
			);
		});

		it('preserves newer data when a retained patch body is unavailable', async function () {
			if (!isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 1000);
			await T.put('bodyless', { c: 'stale' }, { timestamp });
			await T.patch('bodyless', { b: 'newer' }, { timestamp: timestamp + 20 });
			const key = T.primaryStore.getEntry('bodyless').localTime;
			const entry = T.auditStore.get(key);
			const header = Buffer.from(entry.encoded.subarray(0, entry.encoded.length - entry.getBinaryValue().length));
			await T.auditStore.put(key, header);
			assert.equal(T.auditStore.get(key).getValue(T.primaryStore), undefined);
			await T.put('bodyless', { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await T.get('bodyless')) },
				{
					id: 'bodyless',
					c: 'stale',
					b: 'newer',
					a: 'replacement',
				}
			);
		});

		it('preserves newer data behind a corrupt audit header', async function () {
			if (!isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 1000);
			await T.put('corrupt', { c: 'stale' }, { timestamp });
			await T.patch('corrupt', { b: 'newer' }, { timestamp: timestamp + 20 });
			const key = T.primaryStore.getEntry('corrupt').localTime;
			await T.patch('corrupt', { d: 'latest' }, { timestamp: timestamp + 30 });
			await T.auditStore.put(key, Buffer.from([0x40, 0, 0]));
			assert.equal(T.auditStore.get(key).type, undefined);
			await T.put('corrupt', { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await T.get('corrupt')) },
				{
					id: 'corrupt',
					c: 'stale',
					b: 'newer',
					d: 'latest',
					a: 'replacement',
				}
			);
		});

		it('preserves a newer sibling whose record ID cannot be decoded', async function () {
			if (!isLMDB) return this.skip();
			const id = 'aaaaaaaaaa';
			const timestamp = (nextTimestamp += 1000);
			await T.put(id, { c: 'retained' }, { timestamp });
			const context = { timestamp: timestamp + 20 };
			await transaction(context, async () => {
				await T.patch(id, { b: 'first' }, context);
				await T.patch(id, { d: 'last' }, context);
			});
			const key = T.primaryStore.getEntry(id).localTime;
			const entry = T.auditStore.get(key);
			const encoded = Buffer.from(entry.encoded);
			const idOffset = encoded.indexOf(id);
			assert.ok(idOffset >= 0);
			Buffer.from('13195fb7a854cde125e9', 'hex').copy(encoded, idOffset);
			await T.auditStore.put(key, encoded);
			const corrupt = T.auditStore.get(key);
			assert.equal(corrupt.type, 'patch');
			assert.equal(corrupt.recordId, undefined);
			assert.deepStrictEqual({ ...corrupt.getValue(T.primaryStore) }, { d: 'last' });
			await T.put(id, { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual({ ...(await T.get(id)) }, { id, c: 'retained', b: 'first', d: 'last', a: 'replacement' });
		});

		it('preserves a newer sibling whose version is not finite', async function () {
			if (!isLMDB) return this.skip();
			const id = 'bad-version';
			const timestamp = (nextTimestamp += 1000);
			await T.put(id, { c: 'retained' }, { timestamp });
			const context = { timestamp: timestamp + 20 };
			await transaction(context, async () => {
				await T.patch(id, { b: 'first' }, context);
				await T.patch(id, { d: 'last' }, context);
			});
			const first = [...T.auditStore.getRange({ start: 0, end: Infinity })].find(
				(entry) =>
					entry.tableId === T.tableId &&
					entry.recordId === id &&
					entry.type === 'patch' &&
					entry.getValue(T.primaryStore).b === 'first'
			);
			assert.ok(first);
			const encoded = Buffer.from(first.encoded);
			const versionBytes = Buffer.alloc(8);
			versionBytes.writeDoubleBE(timestamp + 20);
			const offset = encoded.indexOf(versionBytes);
			assert.ok(offset >= 0);
			encoded.writeDoubleBE(NaN, offset);
			await T.auditStore.put(first.key, encoded);
			assert.ok(Number.isNaN(T.auditStore.get(first.key).version));
			await T.put(id, { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual({ ...(await T.get(id)) }, { id, c: 'retained', b: 'first', d: 'last', a: 'replacement' });
		});

		it('keeps the merge when an audit branch has an unreadable clock', async function () {
			if (!isLMDB) return this.skip();
			const id = 'bad-reference';
			const timestamp = (nextTimestamp += 1000);
			await T.put(id, { c: 'retained' }, { timestamp });
			await T.patch(id, { b: 'newer' }, { timestamp: timestamp + 20 });
			const key = T.primaryStore.getEntry(id).localTime;
			const entry = T.auditStore.get(key);
			await T.auditStore.put(
				key,
				Buffer.from(
					createAuditEntry({
						version: entry.version,
						tableId: T.tableId,
						recordId: id,
						nodeId: 0,
						type: 'patch',
						previousVersion: entry.previousVersion,
						extendedType: HAS_ADDITIONAL_AUDIT_REFS,
						previousAdditionalAuditRefs: [{ version: NaN, nodeId: 0 }],
						encodedRecord: entry.getBinaryValue(),
					})
				)
			);
			assert.ok(Number.isNaN(T.auditStore.get(key).previousAdditionalAuditRefs[0].version));
			await T.put(id, { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual({ ...(await T.get(id)) }, { id, c: 'retained', b: 'newer', a: 'replacement' });
		});

		it('replays equal-version origins in the existing node-name order', async function () {
			if (isLMDB) return this.skip();
			for (const order of [
				[0, 1],
				[1, 0],
			]) {
				const timestamp = (nextTimestamp += 1000);
				const id = `ties-${order.join('-')}`;
				async function apply(value, version, logKey, origin, fullUpdate = false) {
					const nodeId = getIdOfRemoteNode(origin, T.auditStore);
					const context = { source: {}, sourceApply: true, timestamp: logKey };
					await transaction(context, async () => {
						const resource = await T.getResource(id, context);
						await resource._writeUpdate(id, value, fullUpdate, { isNotification: true, nodeId, version });
					});
				}
				await apply({ id, c: 'stale' }, timestamp, timestamp + 100, 'tie-base', true);
				const patches = [
					{ value: { b: 'alpha', first: true }, origin: 'tie-alpha' },
					{ value: { b: 'zeta', second: true }, origin: 'tie-zeta' },
				];
				for (const [arrival, index] of order.entries()) {
					const { value, origin } = patches[index];
					await apply(value, timestamp + 20, timestamp + 200 + arrival, origin);
				}
				assert.strictEqual((await T.get(id)).b, 'zeta');
				await apply({ id, a: 'replacement' }, timestamp + 10, timestamp + 400, 'tie-base', true);
				assert.deepStrictEqual(
					{ ...(await T.get(id)) },
					{
						id,
						a: 'replacement',
						b: 'zeta',
						first: true,
						second: true,
					}
				);
			}
		});

		it('preserves timestamp metadata while storing the original PUT in audit history', async () => {
			const Metadata = table({
				table: `Metadata${loadAsInstance}`,
				database: 'fullPutBoundaries',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'created', type: 'Float', assignCreatedTime: true },
					{ name: 'updated', type: 'Float', assignUpdatedTime: true },
				],
			});
			Metadata.loadAsInstance = loadAsInstance;
			const timestamp = (nextTimestamp += 1000);
			await Metadata.put('metadata', { c: 'stale' }, { timestamp });
			await Metadata.patch('metadata', { b: 'newer' }, { timestamp: timestamp + 20 });
			await Metadata.put('metadata', { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await Metadata.get('metadata')) },
				{
					id: 'metadata',
					a: 'replacement',
					b: 'newer',
					created: timestamp,
					updated: timestamp + 20,
				}
			);
			const audit = [...Metadata.auditStore.getRange({ start: 0, end: Infinity })].find(
				(entry) =>
					entry.tableId === Metadata.tableId && entry.recordId === 'metadata' && entry.version === timestamp + 10
			);
			assert.ok(audit);
			assert.deepStrictEqual(
				{ ...audit.getValue(Metadata.primaryStore) },
				{
					id: 'metadata',
					a: 'replacement',
					created: timestamp,
					updated: timestamp + 10,
				}
			);
		});

		it('retains a newer-only file-backed blob after the reclamation window', async () => {
			const Blobs = table({
				table: `Blobs${loadAsInstance}`,
				database: 'fullPutBoundaries',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'blob', type: 'Blob' },
				],
			});
			Blobs.loadAsInstance = loadAsInstance;
			const timestamp = (nextTimestamp += 1000);
			const content = 'newer blob'.repeat(4096);
			await Blobs.put('blob', { c: 'stale' }, { timestamp });
			const retainedBlob = new Blob([content]);
			await Blobs.patch('blob', { blob: retainedBlob }, { timestamp: timestamp + 20 });
			await isSaving(retainedBlob);
			const fileId = getFileId((await Blobs.get('blob')).blob);
			assert.ok(fileId, 'must use a file-backed blob');
			const Sentinel = table({
				table: `BlobSentinel${loadAsInstance}`,
				database: 'fullPutBoundaries',
				audit: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'blob', type: 'Blob' },
				],
			});
			const sentinelBlob = new Blob([content]);
			await Sentinel.put('sentinel', { blob: sentinelBlob });
			await isSaving(sentinelBlob);
			const sentinelPath = getFilePathForBlob(Sentinel.primaryStore.getSync('sentinel').blob);
			assert.ok(existsSync(sentinelPath));
			setDeletionDelay(0);
			try {
				await Blobs.put('blob', { a: 'replacement' }, { timestamp: timestamp + 10 });
				await Sentinel.delete('sentinel');
				await waitFor(() => !existsSync(sentinelPath), {
					timeout: 5000,
					message: 'the reclamation sentinel was not deleted',
				});
				const record = await Blobs.get('blob');
				assert.equal(record.c, undefined);
				assert.strictEqual(getFileId(record.blob), fileId);
				assert.ok(existsSync(getFilePathForBlob(record.blob)));
				assert.strictEqual(await record.blob.text(), content);
			} finally {
				setDeletionDelay(undefined);
			}
		});

		it('replays newer patches collected from separate origin branches', async function () {
			if (isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 1000);
			async function apply(value, offset, origin, fullUpdate = false) {
				const nodeId = getIdOfRemoteNode(origin, T.auditStore);
				const context = { source: {}, sourceApply: true, timestamp: timestamp + offset };
				await transaction(context, async () => {
					const resource = await T.getResource('origins', context);
					await resource._writeUpdate('origins', value, fullUpdate, {
						isNotification: true,
						nodeId,
						version: timestamp + offset,
					});
				});
			}
			await apply({ id: 'origins', c: 'stale' }, 0, 'full-put-base', true);
			await apply({ b: 'newest' }, 30, 'full-put-first');
			await apply({ counter: { __op__: 'add', value: 5 } }, 20, 'full-put-second');
			await apply({ id: 'origins', a: 'replacement' }, 10, 'full-put-base', true);
			assert.deepStrictEqual(
				{ ...(await T.get('origins')) },
				{
					id: 'origins',
					a: 'replacement',
					b: 'newest',
					counter: 5,
				}
			);
		});
	});
}
