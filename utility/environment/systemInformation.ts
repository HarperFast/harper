import { readFile } from 'node:fs/promises';
import path from 'node:path';
import si from 'systeminformation';
import logger from '../logging/harper_logger.js';
import * as hdbTerms from '../hdbTerms.ts';
import { lmdbGetTableSize } from '../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbGetTableSize.ts';
import { getThreadInfo } from '../../server/threads/manageThreads.js';
import env from './environmentManager.js';
import { getDatabases, type Table } from '../../resources/databases.ts';
import { TableSizeObject } from '../../dataLayer/harperBridge/TableSizeObject.ts';
import { RocksDatabase, StatsHistogramData } from '@harperfast/rocksdb-js';

env.initSync();

//this will hold the system_information which is static to improve performance
let systemInformationCache = undefined;

export class SystemInformationRequest {
	operator: string;
	attributes: string[];

	constructor(attributes) {
		this.operator = hdbTerms.OPERATIONS_ENUM.SYSTEM_INFORMATION;
		this.attributes = attributes;
	}
}

export class SystemInformationResponse {
	system?: SystemInfo;
	time?: TimeData;
	cpu?: CpuInfo;
	memory?: MemoryInfo;
	disk?: DiskInfo;
	network?: NetworkInfo;
	harperdb_processes?: HarperdbProcesses;
	table_size?: TableSizeObject[];
	metrics?: DatabaseMetrics;
	threads?: Record<string, unknown>;

	constructor(
		system?: SystemInfo,
		time?: TimeData,
		cpu?: CpuInfo,
		memory?: MemoryInfo,
		disk?: DiskInfo,
		network?: NetworkInfo,
		harperdbProcesses?: HarperdbProcesses,
		tableSize?: TableSizeObject[],
		metrics?: DatabaseMetrics,
		threads?: Record<string, unknown>
	) {
		this.system = system;
		this.time = time;
		this.cpu = cpu;
		this.memory = memory;
		this.disk = disk;
		this.network = network;
		this.harperdb_processes = harperdbProcesses;
		this.table_size = tableSize;
		this.metrics = metrics;
		this.threads = threads;
	}
}

type TimeData = si.Systeminformation.TimeData;

/**
 * Returns the current local time, uptime, timezone, and timezone name.
 */
export function getTimeInfo(): TimeData {
	return si.time();
}

type CpuInfo = Pick<
	si.Systeminformation.CpuData,
	| 'manufacturer'
	| 'brand'
	| 'vendor'
	| 'speed'
	| 'cores'
	| 'physicalCores'
	| 'performanceCores'
	| 'efficiencyCores'
	| 'processors'
	| 'flags'
	| 'virtualization'
> & {
	cpu_speed: si.Systeminformation.CpuCurrentSpeedData;
	current_load: Pick<
		si.Systeminformation.CurrentLoadData,
		| 'avgLoad'
		| 'currentLoad'
		| 'currentLoadUser'
		| 'currentLoadSystem'
		| 'currentLoadNice'
		| 'currentLoadIdle'
		| 'currentLoadIrq'
	> & {
		cpus: Pick<
			si.Systeminformation.CurrentLoadCpuData,
			'load' | 'loadUser' | 'loadSystem' | 'loadNice' | 'loadIdle' | 'loadIrq'
		>[];
	};
};

/**
 * Detects CPU information such as manufacturer, brand, vendor, speed, cores, physical cores, and
 * processors.
 */
export async function getCPUInfo(): Promise<CpuInfo | null> {
	try {
		const [cpu, cpu_speed, loadInfo] = await Promise.all([si.cpu(), si.cpuCurrentSpeed(), si.currentLoad()]);

		const {
			manufacturer,
			brand,
			vendor,
			speed,
			cores,
			physicalCores,
			performanceCores,
			efficiencyCores,
			processors,
			flags,
			virtualization,
		} = cpu;

		const {
			avgLoad,
			cpus,
			currentLoad,
			currentLoadUser,
			currentLoadSystem,
			currentLoadNice,
			currentLoadIdle,
			currentLoadIrq,
		} = loadInfo;

		return {
			manufacturer,
			brand,
			vendor,
			speed,
			cores,
			physicalCores,
			performanceCores,
			efficiencyCores,
			processors,
			flags,
			virtualization,
			cpu_speed,
			current_load: {
				avgLoad,
				cpus: cpus.map(({ load, loadUser, loadSystem, loadNice, loadIdle, loadIrq }) => ({
					load,
					loadUser,
					loadSystem,
					loadNice,
					loadIdle,
					loadIrq,
				})),
				currentLoad,
				currentLoadUser,
				currentLoadSystem,
				currentLoadNice,
				currentLoadIdle,
				currentLoadIrq,
			},
		};
	} catch (e) {
		logger.error(`error in getCPUInfo: ${e}`);
		return null;
	}
}

type MemoryInfo = Pick<
	si.Systeminformation.MemData,
	| 'total'
	| 'free'
	| 'used'
	| 'active'
	| 'available'
	| 'reclaimable'
	| 'swaptotal'
	| 'swapused'
	| 'swapfree'
	| 'writeback'
	| 'dirty'
> &
	NodeJS.MemoryUsage;

/**
 * Detect system and Node.js memory usage.
 */
export async function getMemoryInfo(): Promise<MemoryInfo | null> {
	try {
		const { total, free, used, active, available, reclaimable, swaptotal, swapused, swapfree, writeback, dirty } =
			await si.mem();
		return {
			total,
			free,
			used,
			active,
			available,
			reclaimable,
			swaptotal,
			swapused,
			swapfree,
			writeback,
			dirty,
			...process.memoryUsage(),
		};
	} catch (e) {
		logger.error(`error in getMemoryInfo: ${e}`);
		return null;
	}
}

async function getHdbPid(): Promise<number | null> {
	try {
		return Number.parseInt(
			await readFile(path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), hdbTerms.HDB_PID_FILE), 'utf8')
		);
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
			logger.warn(
				`Unable to locate 'hdb.pid' file, try stopping and starting Harper. This could be because Harper is not running.`
			);
		} else {
			throw err;
		}
	}
}

type CoreInfo = si.Systeminformation.ProcessesProcessData & { parent?: string };

type HarperdbProcesses = {
	core: CoreInfo[];
};

/**
 * Detects the Harper process PID and returns the process info.
 * @returns {Promise<{core: []}>}
 */
export async function getHDBProcessInfo(): Promise<HarperdbProcesses> {
	const harperdbProcesses: HarperdbProcesses = {
		core: [],
	};

	try {
		const [processes, hdbPid] = await Promise.all([si.processes(), getHdbPid()]);

		const proc = processes.list.find((p) => p.pid === hdbPid);
		if (proc) {
			harperdbProcesses.core.push(proc);
		}
	} catch (e) {
		logger.error(`error in getHDBProcessInfo: ${e}`);
	}
	return harperdbProcesses;
}

type DiskInfo = {
	io?: Pick<si.Systeminformation.DisksIoData, 'rIO' | 'wIO' | 'tIO'>;
	read_write?: Pick<si.Systeminformation.FsStatsData, 'rx' | 'tx' | 'wx'>;
	size?: si.Systeminformation.FsSizeData[];
};

/**
 * Retrieves disk related info & stats
 * @returns {Promise<DiskInfo>}
 */
export async function getDiskInfo(): Promise<DiskInfo> {
	const disk: DiskInfo = {};
	try {
		if (!env.get(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_SYSINFO_DISK)) return disk;

		const [disksIO, fsStats, fsSize] = await Promise.all([si.disksIO(), si.fsStats(), si.fsSize()]);

		const { rIO, wIO, tIO } = disksIO;
		disk.io = { rIO, wIO, tIO };

		const { rx, tx, wx } = fsStats;
		disk.read_write = { rx, tx, wx };

		disk.size = fsSize;
	} catch (e) {
		logger.error(`error in getDiskInfo: ${e}`);
	}
	return disk;
}

type NetworkInfo = {
	default_interface: string | null;
	latency: si.Systeminformation.InetChecksiteData | Record<never, never>;
	interfaces: Pick<
		si.Systeminformation.NetworkInterfacesData,
		| 'iface'
		| 'ifaceName'
		| 'default'
		| 'ip4'
		| 'ip4subnet'
		| 'ip6'
		| 'ip6subnet'
		| 'mac'
		| 'operstate'
		| 'type'
		| 'duplex'
		| 'speed'
	>[];
	stats: any[];
	connections: any[];
};

/**
 * Detects networking connection information & stats
 * @returns {Promise<{interfaces: [], default_interface: null, stats: [], latency: {}, connections: []}>}
 */
export async function getNetworkInfo(): Promise<NetworkInfo> {
	const network: NetworkInfo = {
		default_interface: null,
		latency: {},
		interfaces: [],
		stats: [],
		connections: [],
	};
	try {
		if (!env.get(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_SYSINFO_NETWORK)) return network;

		const [defaultInterface, latency, nInterfaces, stats] = await Promise.all([
			si.networkInterfaceDefault(),
			si.inetChecksite('https://google.com').catch(() => ({})),
			si.networkInterfaces(),
			si.networkStats(),
		]);

		network.default_interface = defaultInterface || null;
		network.latency = latency;

		for (const nInterface of nInterfaces) {
			const {
				iface,
				ifaceName,
				default: isDefault,
				ip4,
				ip4subnet,
				ip6,
				ip6subnet,
				mac,
				operstate,
				type,
				duplex,
				speed,
			} = nInterface;
			network.interfaces.push({
				iface,
				ifaceName,
				default: isDefault,
				ip4,
				ip4subnet,
				ip6,
				ip6subnet,
				mac,
				operstate,
				type,
				duplex,
				speed,
			});
		}

		for (const nStat of stats) {
			const { iface, operstate, rx_bytes, rx_dropped, rx_errors, tx_bytes, tx_dropped, tx_errors } = nStat;
			network.stats.push({ iface, operstate, rx_bytes, rx_dropped, rx_errors, tx_bytes, tx_dropped, tx_errors });
		}
	} catch (e) {
		logger.error(`error in getNetworkInfo: ${e}`);
	}
	return network;
}

type SystemInfo = Partial<
	Pick<
		si.Systeminformation.OsData,
		'platform' | 'distro' | 'release' | 'codename' | 'kernel' | 'arch' | 'hostname' | 'fqdn'
	>
> & {
	node_version?: string;
	npm_version?: string;
};

/**
 * Detect operating system and Node.js runtime information.
 * @returns {Promise<SystemInfo>}
 */
export async function getSystemInformation(): Promise<SystemInfo> {
	if (systemInformationCache !== undefined) {
		return systemInformationCache;
	}

	let systemInfo: SystemInfo = {};
	try {
		const [osInfo, versions] = await Promise.all([si.osInfo(), si.versions('node, npm')]);
		const { platform, distro, release, codename, kernel, arch, hostname, fqdn } = osInfo;
		const { node, npm } = versions;

		systemInfo = {
			platform,
			distro,
			release,
			codename,
			kernel,
			arch,
			hostname,
			fqdn,
			node_version: node,
			npm_version: npm,
		};
		systemInformationCache = systemInfo;
	} catch (e) {
		logger.error(`error in getSystemInformation: ${e}`);
	}
	return systemInfo;
}

function rocksdbGetTableSize(table: Table): TableSizeObject {
	const rocksdb: RocksDatabase = table.primaryStore;
	const stats = rocksdb.getStats();
	const transactionLogSize = rocksdb
		.listLogs()
		.reduce((sum, logName) => sum + rocksdb.useLog(logName).getLogFileSize(), 0);
	return new TableSizeObject(
		table.databaseName,
		table.tableName,
		(stats['rocksdb.estimate-live-data-size'] as number) ?? 0,
		(stats['rocksdb.estimate-num-keys'] as number) ?? 0,
		transactionLogSize
		// transactionLogRecordCount - currently not supported by `rocksdb-js`
	);
}

/**
 * Retrieves table size information.
 * @returns {TableSizeObject[]}
 */
export function getTableSize(): TableSizeObject[] {
	const results: TableSizeObject[] = [];
	const databases = getDatabases();

	for (const db of Object.values(databases)) {
		for (const table of Object.values(db)) {
			if (table.primaryStore.rootStore instanceof RocksDatabase) {
				results.push(rocksdbGetTableSize(table));
			} else {
				results.push(lmdbGetTableSize(table));
			}
		}
	}
	return results;
}

type LMDBEnvStats = {
	entryCount: number;
	overflowPages: number;
	pageSize: number;
	treeBranchPageCount: number;
	treeDepth: number;
	treeLeafPageCount: number;
};

type LMDBStats = LMDBEnvStats & {
	free: LMDBEnvStats;
	lastPageNumber: number;
	lastTxnId: number;
	mapSize: number;
	maxReaders: number;
	numReaders: number;
	root: LMDBEnvStats;
};

const rocksDBDatabaseLevelStats = new Set<string>([
	'blockCacheCapacity',
	'blockCacheDataHit',
	'blockCacheDataMiss',
	'blockCacheFilterHit',
	'blockCacheFilterMiss',
	'blockCacheHit',
	'blockCacheIndexHit',
	'blockCacheIndexMiss',
	'blockCacheMiss',
	'blockCachePinnedUsage',
	'blockCacheUsage',
	'bytesRead',
	'bytesWritten',
	'dbFlushMicros',
	'dbGetMicros',
	'dbSeekMicros',
	'dbWriteMicros',
	'noFileErrors',
	'numberKeysRead',
	'numberKeysWritten',
	'numberReseeksIteration',
	'numRunningFlushes',
	'oldestSnapshotTime',
	'stallMicros',
	'txnOverheadMutexOldCommitMap',
	'txnOverheadMutexPrepare',
	'txnOverheadMutexSnapshot',
]);

type RocksDBStats = {
	blockCacheCapacity: number;
	blockCacheDataHit: number;
	blockCacheDataMiss: number;
	blockCacheFilterHit: number;
	blockCacheFilterMiss: number;
	blockCacheHit: number;
	blockCacheIndexHit: number;
	blockCacheIndexMiss: number;
	blockCacheMiss: number;
	blockCachePinnedUsage: number;
	blockCacheUsage: number;
	bytesRead: number;
	bytesWritten: number;
	dbFlushMicros: StatsHistogramData;
	dbGetMicros: StatsHistogramData;
	dbSeekMicros: StatsHistogramData;
	dbWriteMicros: StatsHistogramData;
	noFileErrors: number;
	numberKeysRead: number;
	numberKeysWritten: number;
	numberReseeksIteration: number;
	numRunningFlushes: number;
	oldestSnapshotTime: number;
	stallMicros: number;
	txnOverheadMutexOldCommitMap: number;
	txnOverheadMutexPrepare: number;
	txnOverheadMutexSnapshot: number;
};

type RocksDBTableStats = {
	blobdbValueSize: StatsHistogramData;
	bloomFilterFullPositive: number;
	bloomFilterFullTruePositive: number;
	bloomFilterUseful: number;
	compactReadBytes: number;
	compactWriteBytes: number;
	compactionCancelled: number;
	compactionPending: number;
	compactionTimesMicros: StatsHistogramData;
	curSizeActiveMemTable: number;
	curSizeAllMemTables: number;
	currentSuperVersionNumber: number;
	dbIterBytesRead: number;
	dbWriteStall: StatsHistogramData;
	estimateLiveDataSize: number;
	estimateNumKeys: number;
	estimatePendingCompactionBytes: number;
	liveBlobFileSize: number;
	liveSstFilesSize: number;
	memTableFlushPending: number;
	memtableHit: number;
	memtableMiss: number;
	numBlobFiles: number;
	numDeletesActiveMemTable: number;
	numEntriesActiveMemTable: number;
	numImmutableMemTable: number;
	numImmutableMemTableFlushed: number;
	numLiveVersions: number;
	numRunningCompactions: number;
	readAmpEstimateUsefulBytes: number;
	readAmpTotalReadBytes: number;
	sizeAllMemTables: number;
	sstReadMicros: StatsHistogramData;
	totalBlobFileSize: number;
	totalSstFilesSize: number;
};

type TableStats =
	| RocksDBTableStats
	| Pick<LMDBStats, 'entryCount' | 'overflowPages' | 'treeBranchPageCount' | 'treeDepth' | 'treeLeafPageCount'>;

// Strips the "rocksdb." prefix and converts kebab-case to camelCase
function toRocksDBCamelCase(key: string): string {
	return key.replace(/^rocksdb\./, '').replace(/[-.]([a-z])/g, (_, c: string) => c.toUpperCase());
}

type DBStats = RocksDBStats & {
	audit?: Pick<LMDBStats, 'treeDepth' | 'treeBranchPageCount' | 'treeLeafPageCount' | 'entryCount' | 'overflowPages'>;
	readers?: { pid: string; thread: string; txnid: string }[];
	tables: Record<string, TableStats>;
};

type DatabaseMetrics = {
	[dbName: string]: DBStats;
};

function getRocksDBStats(table: Table, dbStats: DBStats): void {
	const stats = table.primaryStore.getStats();
	const tableStats = (dbStats.tables[table.tableName] = {} as RocksDBTableStats);

	for (const [key, value] of Object.entries(stats)) {
		const name = toRocksDBCamelCase(key);
		if (rocksDBDatabaseLevelStats.has(name)) {
			dbStats[name] = value;
		} else {
			tableStats[name] = value;
		}
	}
}

function getLMDBStats(table: Table, dbStats: DBStats): void {
	if (!dbStats.readers) {
		const { root: _root, ...stats } = table.primaryStore.rootStore.getStats();
		Object.assign(dbStats, stats);
		dbStats.readers = table.primaryStore.rootStore
			.readerList()
			.split(/\n\s+/)
			.slice(1)
			.map((line) => {
				const [pid, thread, txnid] = line.trim().split(' ');
				return { pid, thread, txnid };
			});
		if (table.auditStore) {
			const { treeDepth, treeBranchPageCount, treeLeafPageCount, entryCount, overflowPages } =
				table.auditStore.getStats();
			dbStats.audit = { treeDepth, treeBranchPageCount, treeLeafPageCount, entryCount, overflowPages };
		}
	}

	const { entryCount, overflowPages, treeBranchPageCount, treeDepth, treeLeafPageCount } =
		table.primaryStore.getStats();
	dbStats.tables[table.tableName] = { entryCount, overflowPages, treeBranchPageCount, treeDepth, treeLeafPageCount };
}

/**
 * Get RocksDB or LMDB metrics for all databases and tables.
 * @returns {Promise<DatabaseMetrics>}
 */
export async function getMetrics(): Promise<DatabaseMetrics> {
	const databaseStats: DatabaseMetrics = {};
	const databases = getDatabases();

	for (const [dbName, db] of Object.entries(databases)) {
		const dbStats = { tables: {} } as DBStats;
		databaseStats[dbName] = dbStats;

		for (const [tableName, table] of Object.entries(db)) {
			try {
				if (table.primaryStore.rootStore instanceof RocksDatabase) {
					getRocksDBStats(table, dbStats);
				} else {
					getLMDBStats(table, dbStats);
				}
			} catch (error) {
				// if a database no longer exists, don't want to throw an error
				logger.notify(`Error getting stats for table ${tableName}: ${error}`);
			}
		}
	}
	return databaseStats;
}

const attributeMap: Record<string, () => Promise<any> | any> = {
	system: getSystemInformation,
	time: getTimeInfo,
	cpu: getCPUInfo,
	memory: getMemoryInfo,
	disk: getDiskInfo,
	network: getNetworkInfo,
	harperdb_processes: getHDBProcessInfo,
	table_size: getTableSize,
	metrics: getMetrics,
	threads: getThreadInfo,
};

/**
 * Retrieves system information for the requested attributes.
 * @param {SystemInformationRequest} systemInfoReq
 * @returns {Promise<SystemInformationResponse>}
 */
export async function systemInformation(systemInfoReq: SystemInformationRequest): Promise<SystemInformationResponse> {
	const attributes =
		Array.isArray(systemInfoReq.attributes) && systemInfoReq.attributes.length > 0
			? systemInfoReq.attributes
			: Object.keys(attributeMap);
	const response = new SystemInformationResponse();
	await Promise.all(
		attributes
			.filter((attr) => attr in attributeMap)
			.map(async (attr) => {
				if (attr === 'database_metrics') {
					attr = 'metrics';
				}
				response[attr] = await attributeMap[attr]();
			})
	);
	return response;
}
