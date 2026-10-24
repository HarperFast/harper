require('../testUtils');
const assert = require('node:assert');
const { writeKey } = require('ordered-binary');
const {
	hashResidencyKey,
	compileResidencyPolicy,
	normalizeResidencyPolicy,
	canonicalShards,
	shardListDigest,
	defaultResidencyMap,
	createResidencyMap,
	validateResidencyMap,
	expandResidencyMap,
	assertResidencyMapChange,
} = require('#src/resources/residencyPolicy');

describe('Residency policy and map identity', () => {
	for (const [id, hex, hash] of [
		['', '1b', 504136826],
		['key1', '6b657931', 927623783],
		[0, '10000000', 1314514469],
		[-0, '18000000', 3485195949],
		[1, '13ff0000', 922627199],
		[-12.5, '0bfd6ffffffffffff0', 3001718541],
		[1n, '13ff0000', 922627199],
		[['tenant', 42], '74656e616e7400140450000000000000', 1488516549],
		[Buffer.from([0, 255, 17]), '00ff11', 59726755],
	]) {
		it(`pins ordered-binary and FNV-1a bytes ${hex}`, () => {
			const buffer = Buffer.alloc(8192);
			const end = writeKey(id, buffer, 0);
			assert.equal(buffer.subarray(0, end).toString('hex'), hex);
			assert.equal(hashResidencyKey(id), hash);
			assert.equal(compileResidencyPolicy({ slots: 100, byAttribute: false })(id), hash % 100);
		});
	}

	it('binds the key independently from attribute names', () => {
		const slot = compileResidencyPolicy({ slots: 100, byAttribute: true, slotFrom: 'id + region + record.offset' });
		assert.equal(slot(10, { id: 98, region: 2, offset: 3 }), 15);
	});

	for (const expression of ['NaN', 'Infinity', '-1', '10', '1.5', '"1"', 'Promise.resolve(1)']) {
		it(`refuses invalid slot expression result ${expression}`, () => {
			const slot = compileResidencyPolicy({ slots: 10, byAttribute: false, slotFrom: expression });
			assert.throws(() => slot('id'), /integer slot/);
		});
	}

	it('observes a rejected asynchronous expression while refusing it synchronously', () => {
		const { spawnSync } = require('node:child_process');
		const script = `const { compileResidencyPolicy } = require('#src/resources/residencyPolicy');
		const slot = compileResidencyPolicy({ slots: 10, byAttribute: false, slotFrom: 'Promise.reject(new Error("async slot"))' });
		try { slot('key'); process.exitCode = 2; } catch (error) { if (!/integer slot/.test(error.message)) throw error; }
		setImmediate(() => {});`;
		const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
			encoding: 'utf8',
			timeout: 10000,
		});
		assert.equal(result.status, 0, result.stderr);
	});

	it('rejects syntax errors at declaration', () => {
		assert.throws(
			() => compileResidencyPolicy({ slots: 10, byAttribute: false, slotFrom: 'id.' }),
			/Invalid.*expression/
		);
		assert.throws(() => normalizeResidencyPolicy({ slots: 10, shards: [0, 1] }), /Unknown/);
	});

	it('makes list ordering irrelevant to the initial snapshot and configuration digest', () => {
		const first = defaultResidencyMap('data', 10, [2, 0, 1]);
		const second = defaultResidencyMap('data', 10, [1, 2, 0]);
		assert.deepEqual(first, second);
		assert.deepEqual([...expandResidencyMap(first)], [0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
		assert.equal(shardListDigest(canonicalShards([2, 1, 0])), shardListDigest(canonicalShards([0, 1, 2])));
		assert.notEqual(shardListDigest([0, 1]), shardListDigest([0, 2]));
		assert.equal(shardListDigest(undefined), null);
	});

	for (const shards of [[], [0, 0], [-1], [65536], [0.5], ['0']]) {
		it(`rejects malformed topology ${JSON.stringify(shards)}`, () => {
			assert.throws(() => canonicalShards(shards), /replication.shards/);
		});
	}

	it('canonicalizes equivalent custom range partitions', () => {
		const one = createResidencyMap('data', 4, [{ start: 0, end: 4, shard: 0 }]);
		const two = createResidencyMap('data', 4, [
			{ start: 2, end: 4, shard: 0 },
			{ start: 0, end: 2, shard: 0 },
		]);
		assert.deepEqual(one, two);
		assert.deepEqual(validateResidencyMap(one, 'data'), one);
		assert.throws(() => validateResidencyMap(one, 'another'), /authorized database/);
		assert.throws(() => validateResidencyMap({ ...one, digest: 'bad' }), /digest mismatch/);
	});

	it('allows extending coverage while refusing active reassignment and version forks', () => {
		const first = createResidencyMap('data', 2, [{ start: 0, end: 2, shard: 0 }]);
		const extension = createResidencyMap(
			'data',
			4,
			[
				{ start: 0, end: 2, shard: 0 },
				{ start: 2, end: 4, shard: 1 },
			],
			2
		);
		assert.doesNotThrow(() => assertResidencyMapChange(first, first, 2));
		assert.doesNotThrow(() => assertResidencyMapChange(first, extension, 2));
		const changed = createResidencyMap('data', 2, [{ start: 0, end: 2, shard: 1 }], 2);
		assert.throws(() => assertResidencyMapChange(first, changed, 2), /cannot be reassigned/);
		assert.doesNotThrow(() => assertResidencyMapChange(first, changed, 0));
		assert.throws(() => assertResidencyMapChange(first, { ...changed, version: 1 }, 0), /Conflicting/);
	});

	for (const ranges of [
		[{ start: 1, end: 4, shard: 0 }],
		[{ start: 0, end: 3, shard: 0 }],
		[
			{ start: 0, end: 3, shard: 0 },
			{ start: 2, end: 4, shard: 1 },
		],
		[{ start: 0, end: 5, shard: 0 }],
	]) {
		it(`refuses incomplete or overlapping coverage ${JSON.stringify(ranges)}`, () => {
			assert.throws(() => createResidencyMap('data', 4, ranges), /[Rr]esidency/);
		});
	}
});
