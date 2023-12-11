'use strict';

const fs = require('fs-extra');
const path = require('path');
const si = require('systeminformation');
const log = require('../logging/harper_logger');
const nats_utils = require('../../server/nats/utility/natsUtils');
const nats_terms = require('../../server/nats/utility/natsTerms');
const terms = require('../hdbTerms');
const lmdb_get_table_size = require('../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbGetTableSize');
const schema_describe = require('../../dataLayer/schemaDescribe');
const { getThreadInfo } = require('../../server/threads/manageThreads');
const env = require('./environmentManager');
env.initSync();

// eslint-disable-next-line no-unused-vars
const SystemInformationObject = require('./SystemInformationObject');
const { openEnvironment } = require('../lmdb/environmentUtility');
const { getSchemaPath } = require('../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');
const { database } = require('../../resources/databases');

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
		return Object.assign(mem_info, process.memoryUsage());
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

		let hdb_pid;
		try {
			hdb_pid = Number.parseInt(
				await fs.readFile(path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), terms.HDB_PID_FILE), 'utf8')
			);
		} catch (err) {
			if (err.code === terms.NODE_ERROR_CODES.ENOENT) {
				log.error(`Unable to locate 'hdb.pid' file, try stopping and starting HarperDB`);
			} else {
				throw err;
			}
		}

		processes.list.forEach((p) => {
			if (p.pid === hdb_pid) {
				harperdb_processes.core.push(p);
			} else if (p.name === 'nats-server') {
				harperdb_processes.clustering.push(p);
			}
		});

		for (const hdb_p of harperdb_processes.core) {
			for (const p of processes.list) {
				if (p.pid === hdb_p.parentPid && (p.name === 'PM2' || p.command === 'PM2')) {
					hdb_p.parent = 'PM2';
				}
			}
		}

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
		let table_stats = (schema_stats[schema_name] = {});
		for (let table_name in schemas[schema_name]) {
			try {
				let env = database({ database: schema_name, table: table_name });
				const stats = env.getStats();
				stats.readers = env
					.readerList()
					.split(/\n\s+/)
					.slice(1)
					.map((line) => {
						const [pid, thread, txnid] = line.trim().split(' ');
						return { pid, thread, txnid };
					});
				table_stats[table_name] = stats;
			} catch (error) {
				// if a schema no longer exists, don't want to throw an error
				log.notify(`Error getting stats for table ${table_name}: ${error}`);
			}
		}
	}
	return schema_stats;
}

async function getNatsStreamInfo() {
	if (env.get(terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		const { js, jsm } = await nats_utils.getNATSReferences();
		const ingest_info = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
		const ingest_consumer = await js.consumers.get(
			nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
			nats_terms.WORK_QUEUE_CONSUMER_NAMES.durable_name
		);

		const res = {
			ingest: {
				stream: { ...ingest_info.state },
				consumer: {
					num_ack_pending: ingest_consumer._info.num_ack_pending,
					num_redelivered: ingest_consumer._info.num_redelivered,
					num_waiting: ingest_consumer._info.num_waiting,
					num_pending: ingest_consumer._info.num_pending,
				},
			},
		};

		if (ingest_info.sources) {
			res.ingest.stream.sources = ingest_info.sources;
		}

		return res;
	}
}

/**
 *
 * @param {SystemInformationOperation} system_info_op
 * @returns {Promise<SystemInformationObject>}
 */
async function systemInformation(system_info_op) {
	let response = new SystemInformationObject();
	if (!Array.isArray(system_info_op.attributes) || system_info_op.attributes.length === 0) {
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
		response.replication = await getNatsStreamInfo();
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
			case 'database_metrics':
			case 'metrics':
				response.metrics = await getMetrics();
				break;
			case 'threads':
				response.threads = await getThreadInfo();
				break;
			case 'replication':
				response.replication = await getNatsStreamInfo();
				break;
			default:
				break;
		}
	}

	return response;
}
