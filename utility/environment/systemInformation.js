'use strict';

const fs = require('fs-extra');
const path = require('path');
const si = require('systeminformation');
const log = require('../logging/harper_logger.js');
const terms = require('../hdbTerms.ts');
const lmdbGetTableSize = require('../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbGetTableSize.js');
const schemaDescribe = require('../../dataLayer/schemaDescribe.js');
const { getThreadInfo } = require('../../server/threads/manageThreads.js');
const env = require('./environmentManager.js');
env.initSync();

const SystemInformationObject = require('./SystemInformationObject.js');
const { databases } = require('../../resources/databases.ts');

//this will hold the system_information which is static to improve performance
let systemInformationCache = undefined;

module.exports = {
	getHDBProcessInfo,
	getNetworkInfo,
	getDiskInfo,
	getMemoryInfo,
	getCPUInfo,
	getTimeInfo,
	getSystemInformation,
	systemInformation,
	getTableSize,
	getMetrics,
};

/**
 * executes the time function to return the time info for the system
 * @returns {Systeminformation.TimeData}
 */
function getTimeInfo() {
	return si.time();
}

/**
 * executes cpu related functions
 * @returns {Promise<{}|Pick<Systeminformation.CpuData, "manufacturer" | "brand" | "vendor" | "speed" | "cores" | "physicalCores" | "processors">>}
 */
async function getCPUInfo() {
	try {
		// eslint-disable-next-line no-unused-vars
		let { family, model, stepping, revision, voltage, speedmin, speedmax, governor, socket, cache, ...cpuInfo } =
			await si.cpu();
		cpuInfo.cpu_speed = await si.cpuCurrentSpeed();

		let {
			// eslint-disable-next-line no-unused-vars
			rawCurrentload,
			rawCurrentloadIdle,
			rawCurrentloadIrq,
			rawCurrentloadNice,
			rawCurrentloadSystem,
			rawCurrentloadUser,
			cpus,
			...cpuCurrentLoad
		} = await si.currentLoad();
		cpuCurrentLoad.cpus = [];
		cpus.forEach((cpuData) => {
			// eslint-disable-next-line no-unused-vars
			let { rawLoad, rawLoadIdle, rawLoadIrq, rawLoadNice, rawLoadSystem, rawLoadUser, ...cpuLoad } = cpuData;
			cpuCurrentLoad.cpus.push(cpuLoad);
		});
		cpuInfo.current_load = cpuCurrentLoad;
		return cpuInfo;
	} catch (e) {
		log.error(`error in getCPUInfo: ${e}`);
		return {};
	}
}

/**
 * fetches information related memory
 * @returns {Promise<{}|Pick<Systeminformation.MemData, "total" | "free" | "used" | "active" | "available" | "swaptotal" | "swapused" | "swapfree">>}
 */
async function getMemoryInfo() {
	try {
		// eslint-disable-next-line no-unused-vars
		let { buffers, cached, slab, buffcache, ...memInfo } = await si.mem();
		return Object.assign(memInfo, process.memoryUsage());
	} catch (e) {
		log.error(`error in getMemoryInfo: ${e}`);
		return {};
	}
}

/**
 * searches for & returns the processes for hdb core
 * @returns {Promise<{core: []}>}
 */
async function getHDBProcessInfo() {
	let harperdbProcesses = {
		core: [],
	};
	try {
		let processes = await si.processes();

		let hdbPid;
		try {
			hdbPid = Number.parseInt(
				await fs.readFile(path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), terms.HDB_PID_FILE), 'utf8')
			);
		} catch (err) {
			if (err.code === terms.NODE_ERROR_CODES.ENOENT) {
				log.warn(
					`Unable to locate 'hdb.pid' file, try stopping and starting HarperDB. This could be because HarperDB is not running.`
				);
			} else {
				throw err;
			}
		}

		processes.list.forEach((p) => {
			if (p.pid === hdbPid) {
				harperdbProcesses.core.push(p);
			}
		});

		for (const hdbP of harperdbProcesses.core) {
			for (const p of processes.list) {
				if (p.pid === hdbP.parentPid && (p.name === 'PM2' || p.command === 'PM2')) {
					hdbP.parent = 'PM2';
				}
			}
		}

		return harperdbProcesses;
	} catch (e) {
		log.error(`error in getHDBProcessInfo: ${e}`);
		return harperdbProcesses;
	}
}

/**
 * gets disk related info & stats
 * @returns {Promise<{}>}
 */
async function getDiskInfo() {
	let disk = {};
	try {
		if (!env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_SYSINFO_DISK)) return disk;
		// eslint-disable-next-line no-unused-vars
		let { rIO_sec, wIO_sec, tIO_sec, ms, ...diskIo } = await si.disksIO();
		disk.io = diskIo;

		// eslint-disable-next-line no-unused-vars
		let { rxSec, txSec, wxSec, ...fsStats } = await si.fsStats();
		disk.read_write = fsStats;

		disk.size = await si.fsSize();

		return disk;
	} catch (e) {
		log.error(`error in getDiskInfo: ${e}`);
		return disk;
	}
}

/**
 * gets networking & connection information & stats
 * @returns {Promise<{interfaces: [], default_interface: null, stats: [], latency: {}, connections: []}>}
 */
async function getNetworkInfo() {
	let network = {
		default_interface: null,
		latency: {},
		interfaces: [],
		stats: [],
		connections: [],
	};
	try {
		if (!env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_SYSINFO_NETWORK)) return network;
		network.default_interface = await si.networkInterfaceDefault();

		network.latency = await si.inetChecksite('google.com');

		let nInterfaces = await si.networkInterfaces();
		nInterfaces.forEach((_interface) => {
			// eslint-disable-next-line no-unused-vars
			let { internal, virtual, mtu, dhcp, dnsSuffix, ieee8021xAuth, ieee8021xState, carrierChanges, ...networkInt } =
				_interface;
			network.interfaces.push(networkInt);
		});

		let stats = await si.networkStats();
		stats.forEach((nStat) => {
			// eslint-disable-next-line no-unused-vars
			let { rxSec, txSec, ms, ...stat } = nStat;
			network.stats.push(stat);
		});

		return network;
	} catch (e) {
		log.error(`error in getNetworkInfo: ${e}`);
		return network;
	}
}

/**
 * gets system information
 * @returns {Promise<Pick<Systeminformation.OsData, "platform" | "distro" | "release" | "codename" | "kernel" | "arch" | "hostname">|{}>}
 */
async function getSystemInformation() {
	if (systemInformationCache !== undefined) {
		return systemInformationCache;
	}

	let system_info = {};
	try {
		// eslint-disable-next-line no-unused-vars
		let { codepage, logofile, serial, build, servicepack, uefi, ...sysInfo } = await si.osInfo();
		system_info = sysInfo;
		let versions = await si.versions('node, npm');
		system_info.node_version = versions.node;
		system_info.npm_version = versions.npm;

		systemInformationCache = system_info;
		return systemInformationCache;
	} catch (e) {
		log.error(`error in getSystemInformation: ${e}`);
		return system_info;
	}
}

async function getTableSize() {
	//get details for all tables
	let tableSizes = [];
	let allSchemas = await schemaDescribe.describeAll();
	for (const tables of Object.values(allSchemas)) {
		for (const tableData of Object.values(tables)) {
			tableSizes.push(await lmdbGetTableSize(tableData));
		}
	}

	return tableSizes;
}
async function getMetrics() {
	let schemaStats = {};
	for (let schemaName in databases) {
		let dbStats = (schemaStats[schemaName] = {});
		let tableStats = (dbStats.tables = {});
		for (let tableName in databases[schemaName]) {
			try {
				let table = databases[schemaName][tableName];
				if (!dbStats.readers) {
					Object.assign(dbStats, table.primaryStore.rootStore.getStats());
					delete dbStats.root;
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
				let tableFullStats = table.primaryStore.getStats();
				let tablePrunedStats = {};
				for (let storeKey of ['treeDepth', 'treeBranchPageCount', 'treeLeafPageCount', 'entryCount', 'overflowPages']) {
					tablePrunedStats[storeKey] = tableFullStats[storeKey];
				}
				tableStats[tableName] = tablePrunedStats;
			} catch (error) {
				// if a schema no longer exists, don't want to throw an error
				log.notify(`Error getting stats for table ${tableName}: ${error}`);
			}
		}
	}
	return schemaStats;
}

/**
 *
 * @param {SystemInformationOperation} systemInfoOp
 * @returns {Promise<SystemInformationObject>}
 */
async function systemInformation(systemInfoOp) {
	let response = new SystemInformationObject();
	if (!Array.isArray(systemInfoOp.attributes) || systemInfoOp.attributes.length === 0) {
		response.system = await getSystemInformation();
		response.time = getTimeInfo();
		response.cpu = await getCPUInfo();
		response.memory = await getMemoryInfo();
		response.disk = await getDiskInfo();
		response.network = await getNetworkInfo();
		response.harperdb_processes = await getHDBProcessInfo();
		response.table_size = await getTableSize();
		response.metrics = await getMetrics();
		response.threads = await getThreadInfo();
		return response;
	}

	for (let x = 0; x < systemInfoOp.attributes.length; x++) {
		switch (systemInfoOp.attributes[x]) {
			case 'system':
				response.system = await getSystemInformation();
				break;
			case 'time':
				response.time = getTimeInfo();
				break;
			case 'cpu':
				response.cpu = await getCPUInfo();
				break;
			case 'memory':
				response.memory = await getMemoryInfo();
				break;
			case 'disk':
				response.disk = await getDiskInfo();
				break;
			case 'network':
				response.network = await getNetworkInfo();
				break;
			case 'harperdb_processes':
				response.harperdb_processes = await getHDBProcessInfo();
				break;
			case 'table_size':
				response.table_size = await getTableSize();
				break;
			case 'database_metrics':
			case 'metrics':
				response.metrics = await getMetrics();
				break;
			case 'threads':
				response.threads = await getThreadInfo();
				break;
			default:
				break;
		}
	}

	return response;
}
