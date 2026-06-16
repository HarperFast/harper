const chai = require('chai');
const expect = chai.expect;
const {
	diffResourceUsage,
	calculateCPUUtilization,
	getDirectorySizeAsync,
	toRocksDBCamelCase,
	diffRocksDBCounter,
	normalizeRocksDBStats,
	normalizeTxnLogStats,
	buildRocksDBDbMetric,
	buildRocksDBTableMetric,
	buildRocksDBTxnLogMetric,
} = require('#src/resources/analytics/write');
const { writeFile, mkdtemp, rm, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

describe('diffResourceUsage', () => {
	it('diffs all counters', () => {
		const lastResourceUsage = {
			userCPUTime: 100,
			systemCPUTime: 200,
			minorPageFault: 300,
			majorPageFault: 400,
			fsRead: 500,
			fsWrite: 600,
			voluntaryContextSwitches: 700,
			involuntaryContextSwitches: 800,
		};

		const resourceUsage = {
			userCPUTime: 1000,
			systemCPUTime: 2000,
			minorPageFault: 3000,
			majorPageFault: 4000,
			fsRead: 5000,
			fsWrite: 6000,
			voluntaryContextSwitches: 7000,
			involuntaryContextSwitches: 8000,
		};

		const diffed = diffResourceUsage(lastResourceUsage, resourceUsage);

		expect(diffed).to.deep.equal({
			userCPUTime: 900,
			systemCPUTime: 1800,
			minorPageFault: 2700,
			majorPageFault: 3600,
			fsRead: 4500,
			fsWrite: 5400,
			voluntaryContextSwitches: 6300,
			involuntaryContextSwitches: 7200,
		});
	});

	it('treats missing params as zeroes', () => {
		const resourceUsage = {
			userCPUTime: 1000,
			systemCPUTime: 2000,
			minorPageFault: 3000,
			majorPageFault: 4000,
			fsRead: 5000,
			fsWrite: 6000,
			voluntaryContextSwitches: 7000,
			involuntaryContextSwitches: 8000,
		};

		const diffed = diffResourceUsage({}, resourceUsage);

		expect(diffed).to.deep.equal({
			...resourceUsage,
			userCPUTime: 1000,
			systemCPUTime: 2000,
		});
	});
});

describe('getDirectorySizeAsync', () => {
	let tmpDir;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'harper-test-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('sums file sizes in a flat directory', async () => {
		await writeFile(join(tmpDir, 'a.txt'), 'hello'); // 5 bytes
		await writeFile(join(tmpDir, 'b.txt'), 'world!'); // 6 bytes
		const size = await getDirectorySizeAsync(tmpDir);
		expect(size).to.equal(11);
	});

	it('recurses into subdirectories', async () => {
		const sub = join(tmpDir, 'sub');
		await mkdir(sub);
		await writeFile(join(tmpDir, 'root.txt'), 'aaa'); // 3 bytes
		await writeFile(join(sub, 'nested.txt'), 'bbbbb'); // 5 bytes
		const size = await getDirectorySizeAsync(tmpDir);
		expect(size).to.equal(8);
	});

	it('returns 0 for an empty directory', async () => {
		const size = await getDirectorySizeAsync(tmpDir);
		expect(size).to.equal(0);
	});

	it('returns 0 for a nonexistent path', async () => {
		const size = await getDirectorySizeAsync(join(tmpDir, 'nope'));
		expect(size).to.equal(0);
	});
});

describe('calculateCPUUtilization', () => {
	it('computes utilization based on user + system over period', () => {
		const ru = {
			userCPUTime: 10000,
			systemCPUTime: 20000,
		};

		const cpuUtilization = calculateCPUUtilization(ru, 60000);

		expect(cpuUtilization).to.equal(0.5);
	});
});

describe('toRocksDBCamelCase', () => {
	it('strips the rocksdb. prefix and camelCases dotted segments', () => {
		expect(toRocksDBCamelCase('rocksdb.block.cache.hit')).to.equal('blockCacheHit');
	});

	it('camelCases hyphenated segments', () => {
		expect(toRocksDBCamelCase('rocksdb.bytes-read')).to.equal('bytesRead');
	});

	it('handles mixed dots and hyphens', () => {
		expect(toRocksDBCamelCase('rocksdb.block.cache.data-hit')).to.equal('blockCacheDataHit');
	});
});

describe('diffRocksDBCounter', () => {
	it('returns current value when no previous reading exists', () => {
		expect(diffRocksDBCounter(500, undefined)).to.equal(500);
	});

	it('returns the delta between samples', () => {
		expect(diffRocksDBCounter(1000, 400)).to.equal(600);
	});

	it('returns current value when counter went backwards (process restart)', () => {
		expect(diffRocksDBCounter(50, 1000)).to.equal(50);
	});

	it('returns 0 when counter is unchanged', () => {
		expect(diffRocksDBCounter(1000, 1000)).to.equal(0);
	});
});

describe('normalizeRocksDBStats', () => {
	it('strips rocksdb. prefix and camelCases keys', () => {
		const out = normalizeRocksDBStats({
			'rocksdb.bytes-read': 100,
			'rocksdb.block.cache.hit': 50,
		});
		expect(out).to.deep.equal({ bytesRead: 100, blockCacheHit: 50 });
	});

	it('drops non-numeric values (e.g. histogram objects)', () => {
		const out = normalizeRocksDBStats({
			'rocksdb.bytes-read': 100,
			'rocksdb.db.get.micros': { p50: 1, p95: 10, p99: 50 },
		});
		expect(out).to.deep.equal({ bytesRead: 100 });
	});
});

describe('buildRocksDBDbMetric', () => {
	const now = 1_700_000_000_000;

	it('builds a metric with the correct shape on first sample', () => {
		const stats = {
			bytesRead: 100,
			bytesWritten: 200,
			numberKeysRead: 10,
			numberKeysWritten: 20,
			blockCacheHit: 5,
			blockCacheMiss: 1,
			blockCacheDataHit: 4,
			blockCacheDataMiss: 1,
			blockCacheIndexHit: 1,
			blockCacheIndexMiss: 0,
			blockCacheFilterHit: 0,
			blockCacheFilterMiss: 0,
			stallMicros: 0,
			memtableHit: 25,
			memtableMiss: 7,
			blockCacheUsage: 1024,
			blockCacheCapacity: 8192,
			numRunningFlushes: 0,
		};
		const metric = buildRocksDBDbMetric('mydb', stats, undefined, now, undefined);
		expect(metric).to.include({
			metric: 'rocksdb-stats',
			database: 'mydb',
			time: now,
		});
		// All counters are absolute on first sample (no previous reading).
		expect(metric.bytesRead).to.equal(100);
		expect(metric.bytesWritten).to.equal(200);
		expect(metric.blockCacheHit).to.equal(5);
		expect(metric.memtableHit).to.equal(25);
		expect(metric.memtableMiss).to.equal(7);
		// Gauges pass through absolute.
		expect(metric.blockCacheUsage).to.equal(1024);
		expect(metric.blockCacheCapacity).to.equal(8192);
		// period omitted when undefined.
		expect(metric).to.not.have.property('period');
	});

	it('diffs counters and passes gauges through on subsequent samples', () => {
		const last = {
			bytesRead: 100,
			bytesWritten: 200,
			blockCacheHit: 5,
			memtableHit: 10,
			memtableMiss: 2,
			blockCacheUsage: 999,
		};
		const stats = {
			bytesRead: 350, // delta 250
			bytesWritten: 600, // delta 400
			blockCacheHit: 12, // delta 7
			memtableHit: 25, // delta 15
			memtableMiss: 7, // delta 5
			blockCacheUsage: 2048, // gauge — absolute
		};
		const metric = buildRocksDBDbMetric('mydb', stats, last, now, 5000);
		expect(metric.period).to.equal(5000);
		expect(metric.bytesRead).to.equal(250);
		expect(metric.bytesWritten).to.equal(400);
		expect(metric.blockCacheHit).to.equal(7);
		expect(metric.memtableHit).to.equal(15);
		expect(metric.memtableMiss).to.equal(5);
		expect(metric.blockCacheUsage).to.equal(2048);
	});

	it('defaults missing stats to 0', () => {
		const metric = buildRocksDBDbMetric('mydb', {}, undefined, now, undefined);
		expect(metric.bytesRead).to.equal(0);
		expect(metric.blockCacheUsage).to.equal(0);
		expect(metric.numRunningFlushes).to.equal(0);
	});

	it('folds the txnlog roll-up onto the db row (counters diffed, gauges absolute)', () => {
		const last = { txnlogBytesWritten: 1000, txnlogTransactionsWritten: 40 };
		const stats = {
			txnlogBytesWritten: 1500, // delta 500
			txnlogTransactionsWritten: 55, // delta 15
			txnlogLogCount: 2,
			txnlogTotalSizeBytes: 4096,
			txnlogReplayGapBytes: 512,
		};
		const metric = buildRocksDBDbMetric('mydb', stats, last, now, 5000);
		expect(metric.metric).to.equal('rocksdb-stats');
		expect(metric.txnlogBytesWritten).to.equal(500);
		expect(metric.txnlogTransactionsWritten).to.equal(15);
		expect(metric.txnlogLogCount).to.equal(2);
		expect(metric.txnlogTotalSizeBytes).to.equal(4096);
		expect(metric.txnlogReplayGapBytes).to.equal(512);
	});
});

describe('buildRocksDBTableMetric', () => {
	const now = 1_700_000_000_000;

	it('includes database and table fields', () => {
		const metric = buildRocksDBTableMetric('mydb', 'mytable', {}, now, undefined);
		expect(metric).to.include({
			metric: 'rocksdb-stats',
			database: 'mydb',
			table: 'mytable',
			time: now,
		});
	});

	it('passes compaction gauges through and reports period', () => {
		const stats = {
			numRunningCompactions: 1,
			compactionPending: 1,
		};
		const metric = buildRocksDBTableMetric('mydb', 'mytable', stats, now, 1000);
		expect(metric.numRunningCompactions).to.equal(1);
		expect(metric.compactionPending).to.equal(1);
		expect(metric.period).to.equal(1000);
	});

	it('does not emit memtable counters on the table row (they are DB-wide)', () => {
		const stats = { memtableHit: 25, memtableMiss: 7, numRunningCompactions: 1, compactionPending: 1 };
		const metric = buildRocksDBTableMetric('mydb', 'mytable', stats, now, 1000);
		expect(metric).to.not.have.property('memtableHit');
		expect(metric).to.not.have.property('memtableMiss');
	});
});

// A representative log.getStats() snapshot covering every nested group plus the fields we drop.
const sampleTxnLogStats = () => ({
	name: 'audit',
	path: '/data/mydb/txnlog/audit',
	fileCount: 4,
	currentSequenceNumber: 42,
	oldestSequenceNumber: 38,
	totalSizeBytes: 8192,
	currentFileSize: 2048,
	pendingTransactions: 3,
	uncommittedTransactions: 1,
	replayGapBytes: 512,
	memory: { mappedBytes: 65536, overlayBytes: 4096, activeMaps: 2 },
	nextLogPosition: { sequence: 42, offset: 2048 },
	lastFlushedPosition: { sequence: 42, offset: 1536 },
	lastCommittedPosition: { sequence: 42, offset: 1024 },
	purge: { oldestFileAgeMs: 90000, purgeableFiles: 1, retainedUnflushedFiles: 0, lastPurgeMs: 1_699_999_900_000 },
	totals: {
		transactionsWritten: 1000,
		entriesWritten: 1200,
		bytesWritten: 500000,
		rotations: 4,
		filesPurged: 2,
		bytesPurged: 16384,
		purgeRuns: 5,
		databaseFlushes: 8,
		writeFailures: 0,
	},
	config: { maxFileSize: 1048576, retentionMs: 86400000, maxAgeThreshold: 0.8 },
});

describe('normalizeTxnLogStats', () => {
	it('flattens the selected performance and resource fields', () => {
		const out = normalizeTxnLogStats(sampleTxnLogStats());
		expect(out).to.deep.equal({
			fileCount: 4,
			totalSizeBytes: 8192,
			currentFileSize: 2048,
			pendingTransactions: 3,
			uncommittedTransactions: 1,
			replayGapBytes: 512,
			memoryMappedBytes: 65536,
			memoryOverlayBytes: 4096,
			memoryActiveMaps: 2,
			purgeOldestFileAgeMs: 90000,
			purgePurgeableFiles: 1,
			purgeRetainedUnflushedFiles: 0,
			totalsTransactionsWritten: 1000,
			totalsEntriesWritten: 1200,
			totalsBytesWritten: 500000,
			totalsRotations: 4,
			totalsWriteFailures: 0,
		});
	});

	it('drops noise fields (path, sequence numbers, positions, lastPurgeMs, config, borderline counters)', () => {
		const out = normalizeTxnLogStats(sampleTxnLogStats());
		for (const dropped of [
			'name',
			'path',
			'currentSequenceNumber',
			'oldestSequenceNumber',
			'nextLogPosition',
			'lastFlushedPosition',
			'lastCommittedPosition',
			'purgeLastPurgeMs',
			'maxFileSize',
			'retentionMs',
			'maxAgeThreshold',
			'totalsFilesPurged',
			'totalsBytesPurged',
			'totalsPurgeRuns',
			'totalsDatabaseFlushes',
		]) {
			expect(out).to.not.have.property(dropped);
		}
	});

	it('tolerates missing nested groups', () => {
		const out = normalizeTxnLogStats({ fileCount: 1, totalSizeBytes: 10 });
		expect(out).to.deep.equal({ fileCount: 1, totalSizeBytes: 10 });
	});
});

describe('buildRocksDBTxnLogMetric', () => {
	const now = 1_700_000_000_000;

	it('includes database and log dimensions (not table) on the rocksdb-txnlog-stats metric', () => {
		const metric = buildRocksDBTxnLogMetric('mydb', 'audit', {}, undefined, now, undefined);
		expect(metric).to.include({
			metric: 'rocksdb-txnlog-stats',
			database: 'mydb',
			log: 'audit',
			time: now,
		});
		expect(metric).to.not.have.property('table');
		expect(metric).to.not.have.property('period');
	});

	it('reports counters absolute on the first sample', () => {
		const stats = normalizeTxnLogStats(sampleTxnLogStats());
		const metric = buildRocksDBTxnLogMetric('mydb', 'audit', stats, undefined, now, undefined);
		expect(metric.totalsTransactionsWritten).to.equal(1000);
		expect(metric.totalsBytesWritten).to.equal(500000);
		// Gauges always pass through absolute.
		expect(metric.replayGapBytes).to.equal(512);
		expect(metric.memoryOverlayBytes).to.equal(4096);
	});

	it('diffs counters and passes gauges through on subsequent samples', () => {
		const last = { totalsTransactionsWritten: 1000, totalsBytesWritten: 500000, totalsRotations: 4 };
		const stats = {
			totalsTransactionsWritten: 1250, // delta 250
			totalsBytesWritten: 600000, // delta 100000
			totalsRotations: 5, // delta 1
			replayGapBytes: 1024, // gauge — absolute
			pendingTransactions: 7,
		};
		const metric = buildRocksDBTxnLogMetric('mydb', 'audit', stats, last, now, 5000);
		expect(metric.period).to.equal(5000);
		expect(metric.totalsTransactionsWritten).to.equal(250);
		expect(metric.totalsBytesWritten).to.equal(100000);
		expect(metric.totalsRotations).to.equal(1);
		expect(metric.replayGapBytes).to.equal(1024);
		expect(metric.pendingTransactions).to.equal(7);
	});

	it('defaults missing stats to 0', () => {
		const metric = buildRocksDBTxnLogMetric('mydb', 'audit', {}, undefined, now, undefined);
		expect(metric.totalsTransactionsWritten).to.equal(0);
		expect(metric.replayGapBytes).to.equal(0);
		expect(metric.fileCount).to.equal(0);
	});
});
