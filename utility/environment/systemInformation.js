'use strict';

const path = require('path');
const si = require('systeminformation');
const log = require('../logging/harper_logger');
const terms = require('../hdbTerms');
const lmdb_get_table_size = require('../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbGetTableSize');
const schema_describe = require('../../data_layer/schemaDescribe');
const { sendItcEvent } = require('../../server/threads/itc');
const env = require('./environmentManager');
env.initSync();

// eslint-disable-next-line no-unused-vars
const SystemInformationOperation = require('./SystemInformationOperation');
const SystemInformationObject = require('./SystemInformationObject');
const IPCEventObject = require("../../server/ipc/utility/IPCEventObject");
const hdb_terms = require("../hdbTerms");
const { getBaseSchemaPath } = require("../../data_layer/harperBridge/lmdbBridge/lmdbUtility/initializePaths");
const { openEnvironment } = require("../lmdb/environmentUtility");

//this will hold the system_information which is static to improve performance
let system_information_cache = undefined;

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
		let { family, model, stepping, revision, voltage, speedmin, speedmax, governor, socket, cache, ...cpu_info } =
			await si.cpu();
		cpu_info.cpu_speed = await si.cpuCurrentSpeed();

		let {
			// eslint-disable-next-line no-unused-vars
			raw_currentload,
			raw_currentload_idle,
			raw_currentload_irq,
			raw_currentload_nice,
			raw_currentload_system,
			raw_currentload_user,
			cpus,
			...cpu_current_load
		} = await si.currentLoad();
		cpu_current_load.cpus = [];
		cpus.forEach((cpu_data) => {
			// eslint-disable-next-line no-unused-vars
			let { raw_load, raw_load_idle, raw_load_irq, raw_load_nice, raw_load_system, raw_load_user, ...cpu_load } =
				cpu_data;
			cpu_current_load.cpus.push(cpu_load);
		});
		cpu_info.current_load = cpu_current_load;
		return cpu_info;
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
		let { buffers, cached, slab, buffcache, ...mem_info } = await si.mem();
		return mem_info;
	} catch (e) {
		log.error(`error in getMemoryInfo: ${e}`);
		return {};
	}
}

/**
 * searches for & returns the processes for hdb core & clustering
 * @returns {Promise<{core: [], clustering: []}>}
 */
async function getHDBProcessInfo() {
	let harperdb_processes = {
		core: [],
		clustering: [],
	};
	try {
		let processes = await si.processes();

		processes.list.forEach((process) => {
			if (process.params.includes(terms.HDB_PROC_NAME)) {
				harperdb_processes.core.push(process);
			} else if (process.params.includes('socketcluster')) {
				harperdb_processes.clustering.push(process);
			}
		});
		return harperdb_processes;
	} catch (e) {
		log.error(`error in getHDBProcessInfo: ${e}`);
		return harperdb_processes;
	}
}

/**
 * gets disk related info & stats
 * @returns {Promise<{}>}
 */
async function getDiskInfo() {
	let disk = {};
	try {
		// eslint-disable-next-line no-unused-vars
		let { rIO_sec, wIO_sec, tIO_sec, ms, ...disk_io } = await si.disksIO();
		disk.io = disk_io;

		// eslint-disable-next-line no-unused-vars
		let { rx_sec, tx_sec, wx_sec, ...fs_stats } = await si.fsStats();
		disk.read_write = fs_stats;

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
		network.default_interface = await si.networkInterfaceDefault();

		network.latency = await si.inetChecksite('google.com');

		let n_interfaces = await si.networkInterfaces();
		n_interfaces.forEach((_interface) => {
			// eslint-disable-next-line no-unused-vars
			let { internal, virtual, mtu, dhcp, dnsSuffix, ieee8021xAuth, ieee8021xState, carrier_changes, ...network_int } =
				_interface;
			network.interfaces.push(network_int);
		});

		let stats = await si.networkStats();
		stats.forEach((n_stat) => {
			// eslint-disable-next-line no-unused-vars
			let { rx_sec, tx_sec, ms, ...stat } = n_stat;
			network.stats.push(stat);
		});

		network.connections = await si.networkConnections();

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
	if (system_information_cache !== undefined) {
		return system_information_cache;
	}

	let system_info = {};
	try {
		// eslint-disable-next-line no-unused-vars
		let { codepage, logofile, serial, build, servicepack, uefi, ...sys_info } = await si.osInfo();
		system_info = sys_info;
		let versions = await si.versions('node, npm');
		system_info.node_version = versions.node;
		system_info.npm_version = versions.npm;

		system_information_cache = system_info;
		return system_information_cache;
	} catch (e) {
		log.error(`error in getSystemInformation: ${e}`);
		return system_info;
	}
}

async function getTableSize() {
	//get details for all tables
	let table_sizes = [];
	let all_schemas = await schema_describe.describeAll();
	for (const tables of Object.values(all_schemas)) {
		for (const table_data of Object.values(tables)) {
			table_sizes.push(await lmdb_get_table_size(table_data));
		}
	}

	return table_sizes;
}
async function getMetrics() {
	let schemas = await schema_describe.describeAll();
	let schema_stats = {};
	for (let schema_name in schemas) {
		let table_stats = schema_stats[schema_name] = {};
		for (let table_name in schemas[schema_name]) {
			try {
				let schema_path = path.join(getBaseSchemaPath(), schema_name);
				let env = await openEnvironment(schema_path, table_name);
				let stats = env.getStats();
				table_stats[table_name] = {
					puts: stats.puts,
					deletes: stats.deletes,
					txns: stats.txns,
					pageFlushes: stats.pageFlushes,
					writes: stats.writes,
					pagesWritten: stats.pagesWritten,
					timeDuringTxns: stats.timeDuringTxns,
					timeStartTxns: stats.timeStartTxns,
					timePageFlushes: stats.timePageFlushes,
					timeSync: stats.timeSync,
				};
			} catch(error) {
				// if a schema no longer exists, don't want to throw an error
				log.notify(`Error getting stats for table ${table_name}: ${error}`);
			}
		}
	}
	schema_stats.pid = process.pid;
	if (global.metrics) global.metrics[process.pid] = schema_stats;
	return schema_stats;
}
async function getMetricsFromAllProcesses() {
	// send a request for performance metrics from all processes
	sendItcEvent(new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.GET_METRICS, {}));
	// wait one second for a response
	await new Promise(resolve => setTimeout(resolve, 1000));
	await getMetrics();
	let totals = {};
	for (let process_id in global.metrics) {
		let process_metrics = global.metrics[process_id];
		for (let schema_name in process_metrics) {
			let schema = process_metrics[schema_name];
			let schema_stats = totals[schema_name] || (totals[schema_name] = {});
			for (let table_name in schema) {
				let table = schema[table_name];
				let table_stats = schema_stats[table_name] || (schema_stats[table_name] = {});
				for (let stat_name in table) {
					table_stats[stat_name] = (table_stats[stat_name] || 0) + table[stat_name];
				}
			}
		}
	}
	return totals;
}

/**
 *
 * @param {SystemInformationOperation} system_info_op
 * @returns {Promise<SystemInformationObject>}
 */
async function systemInformation(system_info_op) {
	let response = new SystemInformationObject();
	let metrics = getMetricsFromAllProcesses();
	if (!Array.isArray(system_info_op.attributes) || system_info_op.attributes.length === 0) {
		response.system = await getSystemInformation();
		response.time = getTimeInfo();
		response.cpu = await getCPUInfo();
		response.memory = await getMemoryInfo();
		response.disk = await getDiskInfo();
		response.network = await getNetworkInfo();
		response.harperdb_processes = await getHDBProcessInfo();
		response.table_size = await getTableSize();
		response.metrics = await metrics;
		return response;
	}

	for (let x = 0; x < system_info_op.attributes.length; x++) {
		switch (system_info_op.attributes[x]) {
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
			default:
				break;
		}
	}

	return response;
}
