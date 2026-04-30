'use strict';

const assert = require('assert');
const sinon = require('sinon');
const system_information = require('#js/utility/environment/systemInformation');
const env_mgr = require('#js/utility/environment/environmentManager');

const { SystemInformationRequest } = system_information;

const { TableSizeObject } = require('#js/dataLayer/harperBridge/TableSizeObject');

const PROCESS_INFO = {
	core: [
		{
			pid: 30980,
			parentPid: 1866,
			name: 'harper.js',
			cpu: 0,
			cpuu: 0,
			cpus: 0,
			mem: 1,
			priority: 31,
			memVsz: 443722320,
			memRss: 385216,
			nice: 0,
			started: '2026-04-22 22:35:40',
			state: 'sleeping',
			tty: 'ttys002',
			user: 'lincoln',
			command: 'harper.js',
			params: '',
			path: 'node dist/bin',
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
		'efficiencyCores',
		'performanceCores',
		'processors',
		'cpu_speed',
		'current_load',
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
		'cpus',
	],
	cpu_current_load_cpus: ['load', 'loadUser', 'loadSystem', 'loadNice', 'loadIdle', 'loadIrq'],
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
		'arrayBuffers',
		'dirty',
		'external',
		'reclaimable',
		'writeback',
	],
	disk: ['io', 'read_write', 'size'],
	disk_io: ['rIO', 'wIO', 'tIO'],
	disk_read_write: ['rx', 'wx', 'tx'],
	disk_size: ['fs', 'rw', 'type', 'size', 'used', 'use', 'mount', 'available'],
	network: ['default_interface', 'latency', 'interfaces', 'stats', 'connections'],
	network_latency: ['ms', 'ok', 'status', 'url'],
	network_interfaces: [
		'iface',
		'ifaceName',
		'default',
		'ip4',
		'ip4subnet',
		'ip6',
		'ip6subnet',
		'mac',
		'operstate',
		'type',
		'duplex',
		'speed',
	],
	network_stats: ['iface', 'operstate', 'rx_bytes', 'rx_dropped', 'rx_errors', 'tx_bytes', 'tx_dropped', 'tx_errors'],
	harperdb_processes: ['core'],
	harperdb_processes_core: [
		'pid',
		'parentPid',
		'name',
		'cpu',
		'cpuu',
		'cpus',
		'mem',
		'priority',
		'memVsz',
		'memRss',
		'nice',
		'started',
		'state',
		'tty',
		'user',
		'command',
		'params',
		'path',
	],
	all: ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size', 'metrics', 'threads'],
};

describe('test systemInformation module', () => {
	let getHDBProcessInfoStub;

	before(() => {
		getHDBProcessInfoStub = sinon.stub(system_information, 'getHDBProcessInfo').resolves(PROCESS_INFO);
		sinon
			.stub(system_information, 'getTableSize')
			.returns([
				new TableSizeObject('dev', 'dog', 4096, 0, 0, 4096),
				new TableSizeObject('dev', 'breed', 4096, 0, 0, 4096),
				new TableSizeObject('prod', 'customers', 4096, 0, 0, 4096),
			]);
		env_mgr.setProperty('clustering_enabled', false);
	});

	after(() => {
		sinon.restore();
	});

	it('test getSystemInformation function', async () => {
		const results = await system_information.getSystemInformation();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.system.sort());
	}).timeout(5000);

	it('call getSystemInformation 2nd time to test cache', async () => {
		const results = await system_information.getSystemInformation();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.system.sort());
	});

	it('test getTimeInfo function', () => {
		const results = system_information.getTimeInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.time.sort());
	});

	it('test getCPUInfo function', async () => {
		const results = await system_information.getCPUInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.cpu.sort());
		assert.deepEqual(Object.keys(results.cpu_speed).sort(), EXPECTED_PROPERTIES.cpu_cpu_speed.sort());
		assert.deepEqual(Object.keys(results.current_load).sort(), EXPECTED_PROPERTIES.cpu_current_load.sort());
		assert(Array.isArray(results.current_load.cpus));
		assert.deepEqual(
			Object.keys(results.current_load.cpus[0]).sort(),
			EXPECTED_PROPERTIES.cpu_current_load_cpus.sort()
		);
	});

	it('test getMemoryInfo function', async () => {
		const results = await system_information.getMemoryInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.memory.sort());
	});

	it('test getDiskInfo function', async () => {
		env_mgr.setProperty('operationsApi_sysInfo_disk', true);
		let results = await system_information.getDiskInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.disk.sort());
		assert.deepEqual(Object.keys(results.io).sort(), EXPECTED_PROPERTIES.disk_io.sort());
		assert.deepEqual(Object.keys(results.read_write).sort(), EXPECTED_PROPERTIES.disk_read_write.sort());
		assert(Array.isArray(results.size));
		if (results.size.length > 0) {
			assert.deepEqual(Object.keys(results.size[0]).sort(), EXPECTED_PROPERTIES.disk_size.sort());
		}

		env_mgr.setProperty('operationsApi_sysInfo_disk', false);
		results = await system_information.getDiskInfo();
		assert.deepEqual(results, {});
	});

	it('test getNetworkInfo function', async () => {
		env_mgr.setProperty('operationsApi_sysInfo_network', true);
		let results = await system_information.getNetworkInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.network.sort());
		assert.deepEqual(Object.keys(results.latency).sort(), EXPECTED_PROPERTIES.network_latency.sort());
		assert(Array.isArray(results.interfaces));
		assert.deepEqual(Object.keys(results.interfaces[0]).sort(), EXPECTED_PROPERTIES.network_interfaces.sort());
		assert(Array.isArray(results.stats));
		assert.deepEqual(Object.keys(results.stats[0]).sort(), EXPECTED_PROPERTIES.network_stats.sort());
		assert(Array.isArray(results.connections));

		env_mgr.setProperty('operationsApi_sysInfo_network', false);
		results = await system_information.getNetworkInfo();
		assert.deepEqual(results, {
			default_interface: null,
			latency: {},
			interfaces: [],
			stats: [],
			connections: [],
		});
	});

	it('test getHDBProcessInfo function', async () => {
		// restore stub to exercise the real implementation
		getHDBProcessInfoStub.restore();
		const results = await system_information.getHDBProcessInfo();
		getHDBProcessInfoStub = sinon.stub(system_information, 'getHDBProcessInfo').resolves(PROCESS_INFO);

		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.harperdb_processes.sort());
		assert(Array.isArray(results.core));
		if (results.core.length > 0) {
			assert.deepEqual(Object.keys(results.core[0]).sort(), EXPECTED_PROPERTIES.harperdb_processes_core.sort());
		}
	});

	it('test systemInformation function fetch all attributes', async () => {
		const op = new SystemInformationRequest();
		const results = await system_information.systemInformation(op);
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.all.sort());
	}).timeout(10000);

	it('test systemInformation function fetch some attributes', async () => {
		const expected_attributes = ['time', 'memory'];
		const op = new SystemInformationRequest(expected_attributes);
		const results = await system_information.systemInformation(op);
		const defined = Object.keys(results).filter((key) => results[key] !== undefined);
		assert.deepEqual(defined.sort(), expected_attributes.sort());
	});

	it('test systemInformation function fetch all of the attributes', async () => {
		const op = new SystemInformationRequest(EXPECTED_PROPERTIES.all);
		const results = await system_information.systemInformation(op);
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.all.sort());
	}).timeout(10000);

	it('test getTableSize function', async () => {
		const expected = [
			new TableSizeObject('dev', 'dog', 4096, 0, 0, 4096),
			new TableSizeObject('dev', 'breed', 4096, 0, 0, 4096),
			new TableSizeObject('prod', 'customers', 4096, 0, 0, 4096),
		];

		const results = await system_information.getTableSize();
		assert.deepStrictEqual(results, expected);
	});
});
