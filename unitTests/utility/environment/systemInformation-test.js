'use strict';

const assert = require('assert');
const rewire = require('rewire');
const system_information = require('../../../utility/environment/systemInformation');
const rw_system_information = rewire('../../../utility/environment/systemInformation');
const SystemInformationOperation = require('../../../utility/environment/SystemInformationOperation');

let rw_getHDBProcessInfo;

const PROCESS_INFO = {
    "core": [
        {
            "pid": 30980,
            "parentPid": 1866,
            "name": "node",
            "pcpu": 0,
            "pcpuu": 0,
            "pcpus": 0,
            "pmem": 0.5,
            "priority": 19,
            "mem_vsz": 734698316,
            "mem_rss": 85236,
            "nice": 0,
            "started": "2020-04-15 13:41:25",
            "state": "sleeping",
            "tty": "",
            "user": "kyle",
            "command": "node",
            "params": "/home/kyle/WebstormProjects/harperdb/server/hdb_express.js",
            "path": "/usr/bin"
        },
        {
            "pid": 30991,
            "parentPid": 30980,
            "name": "node",
            "pcpu": 0,
            "pcpuu": 0,
            "pcpus": 0,
            "pmem": 0.5,
            "priority": 19,
            "mem_vsz": 630040924,
            "mem_rss": 85304,
            "nice": 0,
            "started": "2020-04-15 13:41:25",
            "state": "sleeping",
            "tty": "",
            "user": "kyle",
            "command": "node",
            "params": "/home/kyle/WebstormProjects/harperdb/server/hdb_express.js",
            "path": "/usr/bin"
        },
        {
            "pid": 30997,
            "parentPid": 30980,
            "name": "node",
            "pcpu": 4.183266932270916,
            "pcpuu": 2.589641434262948,
            "pcpus": 1.593625498007968,
            "pmem": 0.5,
            "priority": 19,
            "mem_vsz": 629976800,
            "mem_rss": 92576,
            "nice": 0,
            "started": "2020-04-15 13:41:25",
            "state": "sleeping",
            "tty": "",
            "user": "kyle",
            "command": "node",
            "params": "/home/kyle/WebstormProjects/harperdb/server/hdb_express.js",
            "path": "/usr/bin"
        }
    ],
    "clustering": [
        {
            "pid": 31013,
            "parentPid": 30980,
            "name": "node",
            "pcpu": 0,
            "pcpuu": 0,
            "pcpus": 0,
            "pmem": 0.2,
            "priority": 19,
            "mem_vsz": 606288,
            "mem_rss": 40608,
            "nice": 0,
            "started": "2020-04-15 13:41:26",
            "state": "sleeping",
            "tty": "",
            "user": "kyle",
            "command": "node",
            "params": "/home/kyle/WebstormProjects/harperdb/server/socketcluster/Server.js",
            "path": "/usr/bin"
        },
        {
            "pid": 31024,
            "parentPid": 31013,
            "name": "node",
            "pcpu": 0,
            "pcpuu": 0,
            "pcpus": 0,
            "pmem": 0.2,
            "priority": 19,
            "mem_vsz": 670884,
            "mem_rss": 38628,
            "nice": 0,
            "started": "2020-04-15 13:41:26",
            "state": "sleeping",
            "tty": "",
            "user": "kyle",
            "command": "node",
            "params": "/home/kyle/WebstormProjects/harperdb/server/socketcluster/broker.js {\"id\":0,\"debug\":null,\"socketPath\":\"/tmp/socketcluster/socket_server_61253374f8/b0\",\"expiryAccuracy\":5000,\"downgradeToUser\":false,\"brokerControllerPath\":\"/home/kyle/WebstormProjects/harperdb/server/socketcluster/broker.js\",\"processTermTimeout\":10000}",
            "path": "/usr/bin"
        },
        {
            "pid": 31031,
            "parentPid": 31013,
            "name": "node",
            "pcpu": 0,
            "pcpuu": 0,
            "pcpus": 0,
            "pmem": 0.1,
            "priority": 19,
            "mem_vsz": 563692,
            "mem_rss": 29692,
            "nice": 0,
            "started": "2020-04-15 13:41:26",
            "state": "sleeping",
            "tty": "",
            "user": "kyle",
            "command": "node",
            "params": "/home/kyle/WebstormProjects/harperdb/node_modules/socketcluster/default-workercluster-controller.js",
            "path": "/usr/bin"
        },
        {
            "pid": 31038,
            "parentPid": 31031,
            "name": "node",
            "pcpu": 0,
            "pcpuu": 0,
            "pcpus": 0,
            "pmem": 0.4,
            "priority": 19,
            "mem_vsz": 855840,
            "mem_rss": 70820,
            "nice": 0,
            "started": "2020-04-15 13:41:26",
            "state": "sleeping",
            "tty": "",
            "user": "kyle",
            "command": "node",
            "params": "/home/kyle/WebstormProjects/harperdb/server/socketcluster/worker/ClusterWorker.js",
            "path": "/usr/bin"
        }
    ]
};

const EXPECTED_PROPERTIES = {
    system: ["platform", "distro", "release", "codename", "kernel", "arch", "hostname", "node_version", "npm_version"],
    time: ["current", "uptime", "timezone", "timezoneName"],
    cpu: [ "manufacturer", "brand", "vendor", "speed", "cores", "physicalCores", "processors", "cpu_speed", "current_load"],
        cpu_cpu_speed: ["min", "max", "avg", "cores"],
        cpu_current_load: ["avgload", "currentload", "currentload_user", "currentload_system", "currentload_nice", "currentload_idle", "currentload_irq", "cpus"],
            cpu_current_load_cpus: ["load", "load_user", "load_system", "load_nice", "load_idle", "load_irq"],
    memory: ["total", "free", "used", "active", "available", "swaptotal", "swapused", "swapfree"],
    disk: ["io", "read_write", "size"],
        disk_io: ["rIO", "wIO", "tIO"],
        disk_read_write: ["rx", "wx", "tx", "ms"],
        disk_size: ["fs", "type", "size", "used", "use", "mount"],
    network: ['default_interface', 'latency', 'interfaces', 'stats', 'connections'],
        network_latency: ["url", "ok", "status", "ms"],
        network_interfaces: ["iface","ifaceName","ip4","ip6","mac","operstate","type","duplex","speed","carrierChanges"],
        network_stats: ["iface", "operstate", "rx_bytes", "rx_dropped", "rx_errors", "tx_bytes", "tx_dropped", "tx_errors"],
        network_connections: ["protocol", "localaddress", "localport", "peeraddress", "peerport", "state", "pid", "process"],
    harperdb_processes: ["core", "clustering"],
        harperdb_processes_core: ["pid", "parentPid", "name", "pcpu", "pcpuu", "pcpus", "pmem", "priority", "mem_vsz", "mem_rss", "nice", "started", "state",
            "tty", "user", "command", "params", "path"],
    all: ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes']
};

describe('test systemInformation module', ()=>{
    before(()=>{
        rw_getHDBProcessInfo = rw_system_information.__set__('getHDBProcessInfo',async ()=>{ return PROCESS_INFO;});
    });

    after(()=>{
        rw_getHDBProcessInfo();
    });

    it('test getSystemInformation function', async()=>{
        let results = await system_information.getSystemInformation();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.system.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.system.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });
    });

    it('call getSystemInformation 2nd time to test cache', async()=>{
        let results = await system_information.getSystemInformation();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.system.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.system.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });
    });

    it('test getTimeInfo function', ()=>{
        let results = system_information.getTimeInfo();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.time.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.time.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });
    });

    it('test getCPUInfo function', async ()=>{
        let results = await system_information.getCPUInfo();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.cpu.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.cpu.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });

        Object.keys(results.cpu_speed).forEach(key=>{
            assert(EXPECTED_PROPERTIES.cpu_cpu_speed.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.cpu_cpu_speed.forEach(property=>{
            assert(results.cpu_speed.hasOwnProperty(property));
        });

        Object.keys(results.current_load).forEach(key=>{
            assert(EXPECTED_PROPERTIES.cpu_current_load.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.cpu_current_load.forEach(property=>{
            assert(results.current_load.hasOwnProperty(property));
        });

        assert(Array.isArray(results.current_load.cpus));

        Object.keys(results.current_load.cpus[0]).forEach(key=>{
            assert(EXPECTED_PROPERTIES.cpu_current_load_cpus.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.cpu_current_load_cpus.forEach(property=>{
            assert(results.current_load.cpus[0].hasOwnProperty(property));
        });
    });

    it('test getMemoryInfo function', async ()=>{
        let results = await system_information.getMemoryInfo();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.memory.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.memory.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });
    });

    it('test getDiskInfo function', async ()=>{
        let results = await system_information.getDiskInfo();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.disk.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.disk.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });

        Object.keys(results.io).forEach(key=>{
            assert(EXPECTED_PROPERTIES.disk_io.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.disk_io.forEach(property=>{
            assert(results.io.hasOwnProperty(property));
        });

        Object.keys(results.read_write).forEach(key=>{
            assert(EXPECTED_PROPERTIES.disk_read_write.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.disk_read_write.forEach(property=>{
            assert(results.read_write.hasOwnProperty(property));
        });

        assert(Array.isArray(results.size));

        Object.keys(results.size[0]).forEach(key=>{
            assert(EXPECTED_PROPERTIES.disk_size.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.disk_size.forEach(property=>{
            assert(results.size[0].hasOwnProperty(property));
        });
    });

    it('test getNetworkInfo function', async ()=>{
        let results = await system_information.getNetworkInfo();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.network.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.network.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });

        Object.keys(results.latency).forEach(key=>{
            assert(EXPECTED_PROPERTIES.network_latency.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.network_latency.forEach(property=>{
            assert(results.latency.hasOwnProperty(property));
        });

        assert(Array.isArray(results.interfaces));

        Object.keys(results.interfaces[0]).forEach(key=>{
            assert(EXPECTED_PROPERTIES.network_interfaces.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.network_interfaces.forEach(property=>{
            assert(results.interfaces[0].hasOwnProperty(property));
        });

        assert(Array.isArray(results.connections));

        Object.keys(results.connections[0]).forEach(key=>{
            assert(EXPECTED_PROPERTIES.network_connections.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.network_connections.forEach(property=>{
            assert(results.connections[0].hasOwnProperty(property));
        });

        assert(Array.isArray(results.stats));

        Object.keys(results.stats[0]).forEach(key=>{
            assert(EXPECTED_PROPERTIES.network_stats.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.network_stats.forEach(property=>{
            assert(results.stats[0].hasOwnProperty(property));
        });
    });

    it('test getHDBProcessInfo function', async ()=>{
        let results = await rw_system_information.getHDBProcessInfo();

        Object.keys(results).forEach(key=>{
            assert(EXPECTED_PROPERTIES.harperdb_processes.indexOf(key) >= 0);
        });

        EXPECTED_PROPERTIES.harperdb_processes.forEach(property=>{
            assert(results.hasOwnProperty(property));
        });
    });

    it('test getAllSystemInformation function fetch all attributes', async ()=>{
        let op = new SystemInformationOperation();
        let results = await rw_system_information.getAllSystemInformation(op);

        EXPECTED_PROPERTIES.all.forEach(property=>{
            assert(results.hasOwnProperty(property) && results[property] !== undefined);
        });
    });

    it('test getAllSystemInformation function fetch some attributes', async ()=>{
        let expected_attributes = ['time', 'memory'];

        let op = new SystemInformationOperation(expected_attributes);
        let results = await rw_system_information.getAllSystemInformation(op);

        assert(results.time !== undefined);
        assert(results.memory !== undefined);
        assert(results.system === undefined);
        assert(results.cpu === undefined);
        assert(results.disk === undefined);
        assert(results.network === undefined);
        assert(results.harperdb_processes === undefined);
    });
});