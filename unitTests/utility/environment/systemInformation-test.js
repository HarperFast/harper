'use strict';

const assert = require('assert');
const rewire = require('rewire');
const system_information = require('../../../utility/environment/systemInformation');
const rw_system_information = rewire('../../../utility/environment/systemInformation');
const SystemInformationOperation = require('../../../utility/environment/SystemInformationOperation');
const env_mgr = require('../../../utility/environment/environmentManager');

const TableSizeObject = require('../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/TableSizeObject');

let rw_getHDBProcessInfo;

const PROCESS_INFO = {
	core: [
		{
			pid: 30980,
			parentPid: 1866,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.5,
			priority: 19,
			mem_vsz: 734698316,
			mem_rss: 85236,
			nice: 0,
			started: '2020-04-15 13:41:25',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/operationsServer.js',
			path: '/usr/bin',
		},
		{
			pid: 30991,
			parentPid: 30980,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.5,
			priority: 19,
			mem_vsz: 630040924,
			mem_rss: 85304,
			nice: 0,
			started: '2020-04-15 13:41:25',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/operationsServer.js',
			path: '/usr/bin',
		},
		{
			pid: 30997,
			parentPid: 30980,
			name: 'node',
			pcpu: 4.183266932270916,
			pcpuu: 2.589641434262948,
			pcpus: 1.593625498007968,
			pmem: 0.5,
			priority: 19,
			mem_vsz: 629976800,
			mem_rss: 92576,
			nice: 0,
			started: '2020-04-15 13:41:25',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/operationsServer.js',
			path: '/usr/bin',
		},
	],
	clustering: [
		{
			pid: 31013,
			parentPid: 30980,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.2,
			priority: 19,
			mem_vsz: 606288,
			mem_rss: 40608,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/socketcluster/Server.js',
			path: '/usr/bin',
		},
		{
			pid: 31024,
			parentPid: 31013,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.2,
			priority: 19,
			mem_vsz: 670884,
			mem_rss: 38628,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params:
				'/home/kyle/WebstormProjects/harperdb/server/socketcluster/broker.js {"id":0,"debug":null,"socketPath":"/tmp/socketcluster/socket_server_61253374f8/b0","expiryAccuracy":5000,"downgradeToUser":false,"brokerControllerPath":"/home/kyle/WebstormProjects/harperdb/server/socketcluster/broker.js","processTermTimeout":10000}',
			path: '/usr/bin',
		},
		{
			pid: 31031,
			parentPid: 31013,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.1,
			priority: 19,
			mem_vsz: 563692,
			mem_rss: 29692,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/node_modules/socketcluster/default-workercluster-controller.js',
			path: '/usr/bin',
		},
		{
			pid: 31038,
			parentPid: 31031,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.4,
			priority: 19,
			mem_vsz: 855840,
			mem_rss: 70820,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/socketcluster/worker/ClusterWorker.js',
			path: '/usr/bin',
		},
	],
};

const EXPECTED_PROPERTIES = {
	system: [
		'platform',
		'distro',
		'release',
		'codename',
		'kernel',
		'arch',
		'hostname',
		'fqdn',
		'node_version',
		'npm_version',
	],
	time: ['current', 'uptime', 'timezone', 'timezoneName'],
	cpu: [
		'manufacturer',
		'brand',
		'vendor',
		'speed',
		'cores',
		'physicalCores',
		'processors',
		'cpu_speed',
		'current_load',
		'speedMin',
		'speedMax',
		'flags',
		'virtualization',
	],
	cpu_cpu_speed: ['min', 'max', 'avg', 'cores'],
	cpu_current_load: [
		'avgLoad',
		'currentLoad',
		'currentLoadUser',
		'currentLoadSystem',
		'currentLoadNice',
		'currentLoadIdle',
		'currentLoadIrq',
		'rawCurrentLoad',
		'rawCurrentLoadUser',
		'rawCurrentLoadSystem',
		'rawCurrentLoadNice',
		'rawCurrentLoadIdle',
		'rawCurrentLoadIrq',
		'cpus',
	],
	cpu_current_load_cpus: [
		'load',
		'loadUser',
		'loadSystem',
		'loadNice',
		'loadIdle',
		'loadIrq',
		'rawLoad',
		'rawLoadUser',
		'rawLoadSystem',
		'rawLoadNice',
		'rawLoadIdle',
		'rawLoadIrq',
	],
	memory: [
		'total',
		'free',
		'used',
		'active',
		'available',
		'swaptotal',
		'swapused',
		'swapfree',
		'rss',
		'heapUsed',
		'heapTotal',
	],
	disk: ['io', 'read_write'],
	disk_io: ['rIO', 'wIO', 'tIO'],
	disk_read_write: ['rx', 'wx', 'tx', 'ms'],
	disk_size: ['fs', 'type', 'size', 'used', 'use', 'mount', 'available'],
	network: ['default_interface', 'latency', 'interfaces', 'stats', 'connections'],
	network_latency: [], // these should NOT return anything unless enabled
	network_interfaces: [],
	network_stats: [],
	harperdb_processes: ['core', 'clustering'],
	harperdb_processes_core: [
		'pid',
		'parentPid',
		'name',
		'pcpu',
		'pcpuu',
		'pcpus',
		'pmem',
		'priority',
		'mem_vsz',
		'mem_rss',
		'nice',
		'started',
		'state',
		'tty',
		'user',
		'command',
		'params',
		'path',
	],
	all: ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size'],
};

describe('test systemInformation module', () => {
	let rw_getTableSize;
	before(() => {
		rw_getHDBProcessInfo = rw_system_information.__set__('getHDBProcessInfo', async () => {
			return PROCESS_INFO;
		});
		rw_getTableSize = rw_system_information.__set__('getTableSize', async () => {
			return [];
		});

		env_mgr.setProperty('clustering_enabled', false);
	});

	after(() => {
		rw_getHDBProcessInfo();
		rw_getTableSize();
	});

	it('test getSystemInformation function', async () => {
		let results = await system_information.getSystemInformation();

		EXPECTED_PROPERTIES.system.forEach((property) => {
			assert(results.hasOwnProperty(property));
		});
	}).timeout(5000);

	it('call getSystemInformation 2nd time to test cache', async () => {
		let results = await system_information.getSystemInformation();

		EXPECTED_PROPERTIES.system.forEach((property) => {
			assert(results.hasOwnProperty(property));
		});
	}).timeout(5000);

	it('test getTimeInfo function', () => {
		let results = system_information.getTimeInfo();

		Object.keys(results).forEach((key) => {
			assert(EXPECTED_PROPERTIES.time.indexOf(key) >= 0);
		});

		EXPECTED_PROPERTIES.time.forEach((property) => {
			assert(results.hasOwnProperty(property));
		});
	});

	it('test getCPUInfo function', async () => {
		let results = await system_information.getCPUInfo();

		EXPECTED_PROPERTIES.cpu.forEach((property) => {
			assert(results.hasOwnProperty(property));
		});

		Object.keys(results.cpu_speed).forEach((key) => {
			assert(EXPECTED_PROPERTIES.cpu_cpu_speed.indexOf(key) >= 0);
		});

		EXPECTED_PROPERTIES.cpu_cpu_speed.forEach((property) => {
			assert(results.cpu_speed.hasOwnProperty(property));
		});

		EXPECTED_PROPERTIES.cpu_current_load.forEach((property) => {
			assert(results.current_load.hasOwnProperty(property));
		});

		assert(Array.isArray(results.current_load.cpus));

		EXPECTED_PROPERTIES.cpu_current_load_cpus.forEach((property) => {
			assert(results.current_load.cpus[0].hasOwnProperty(property));
		});
	}).timeout(5000);

	it('test getMemoryInfo function', async () => {
		let results = await system_information.getMemoryInfo();

		EXPECTED_PROPERTIES.memory.forEach((property) => {
			assert(results.hasOwnProperty(property));
		});
	});

	it.skip('test getDiskInfo function', async () => {
		let results = await system_information.getDiskInfo();
		if (process.platform !== 'win32') {
			Object.keys(results).forEach((key) => {
				assert(EXPECTED_PROPERTIES.disk.indexOf(key) >= 0);
			});

			EXPECTED_PROPERTIES.disk.forEach((property) => {
				assert(results.hasOwnProperty(property));
			});

			EXPECTED_PROPERTIES.disk_io.forEach((property) => {
				assert(results.io.hasOwnProperty(property));
			});

			Object.keys(results.read_write).forEach((key) => {
				assert(EXPECTED_PROPERTIES.disk_read_write.indexOf(key) >= 0);
			});

			EXPECTED_PROPERTIES.disk_read_write.forEach((property) => {
				assert(results.read_write.hasOwnProperty(property));
			});
		}
	});

	it('test getNetworkInfo function', async () => {
		let results = await system_information.getNetworkInfo();

		Object.keys(results).forEach((key) => {
			assert(EXPECTED_PROPERTIES.network.indexOf(key) >= 0);
		});

		EXPECTED_PROPERTIES.network.forEach((property) => {
			assert(results.hasOwnProperty(property));
		});

		Object.keys(results.latency).forEach((key) => {
			assert(EXPECTED_PROPERTIES.network_latency.indexOf(key) >= 0);
		});

		EXPECTED_PROPERTIES.network_latency.forEach((property) => {
			assert(results.latency.hasOwnProperty(property));
		});

		assert(Array.isArray(results.interfaces));

		EXPECTED_PROPERTIES.network_interfaces.forEach((property) => {
			assert(results.interfaces[0].hasOwnProperty(property));
		});

		assert(Array.isArray(results.stats));

		EXPECTED_PROPERTIES.network_stats.forEach((property) => {
			assert(results.stats[0].hasOwnProperty(property));
		});
	});

	it('test getHDBProcessInfo function', async () => {
		let results = await rw_system_information.getHDBProcessInfo();

		Object.keys(results).forEach((key) => {
			assert(EXPECTED_PROPERTIES.harperdb_processes.indexOf(key) >= 0);
		});

		EXPECTED_PROPERTIES.harperdb_processes.forEach((property) => {
			assert(results.hasOwnProperty(property));
		});
	});

	it('test systemInformation function fetch all attributes', async () => {
		let op = new SystemInformationOperation();
		let results = await rw_system_information.systemInformation(op);

		EXPECTED_PROPERTIES.all.forEach((property) => {
			assert(results.hasOwnProperty(property) && results[property] !== undefined);
		});
	}).timeout(10000);

	it('test systemInformation function fetch some attributes', async () => {
		let expected_attributes = ['time', 'memory'];

		let op = new SystemInformationOperation(expected_attributes);
		let results = await rw_system_information.systemInformation(op);

		assert(results.time !== undefined);
		assert(results.memory !== undefined);
		assert(results.system === undefined);
		assert(results.cpu === undefined);
		assert(results.disk === undefined);
		assert(results.network === undefined);
		assert(results.harperdb_processes === undefined);
	});

	it('test systemInformation function fetch all of the attributes', async () => {
		let expected_attributes = EXPECTED_PROPERTIES.all;

		let op = new SystemInformationOperation(expected_attributes);
		let results = await rw_system_information.systemInformation(op);

		EXPECTED_PROPERTIES.all.forEach((property) => {
			assert(results.hasOwnProperty(property) && results[property] !== undefined);
		});
	}).timeout(10000);
});

describe('test getTableSize function', () => {
	const RETURN_SCHEMA = {
		dev: {
			dog: {
				schema: 'dev',
				name: 'dog',
				hash_attribute: 'id',
			},
			breed: {
				schema: 'dev',
				name: 'breed',
				hash_attribute: 'breed_id',
			},
		},
		prod: {
			customers: {
				schema: 'prod',
				name: 'customers',
				hash_attribute: 'customer_id',
			},
		},
		test: {},
	};
	let rw_schema_describe;
	let rw_lmdb_get_table_size;
	before(() => {
		rw_schema_describe = rw_system_information.__set__('schema_describe', {
			describeAll: async () => RETURN_SCHEMA,
		});

		rw_lmdb_get_table_size = rw_system_information.__set__('lmdb_get_table_size', async (table_object) => {
			return new TableSizeObject(table_object.schema, table_object.name, 4096, 0, 0, 4096);
		});
	});

	after(() => {
		rw_schema_describe();
		rw_lmdb_get_table_size();
	});

	it('test function', async () => {
		let expected = [
			new TableSizeObject('dev', 'dog', 4096, 0, 0, 4096),
			new TableSizeObject('dev', 'breed', 4096, 0, 0, 4096),
			new TableSizeObject('prod', 'customers', 4096, 0, 0, 4096),
		];

		let results = await rw_system_information.getTableSize();
		assert.deepStrictEqual(results, expected);
	});
});
