'use strict';

class SystemInformationObject {
	constructor(system, time, cpu, memory, disk, network, harperdb_processes) {
		this.system = system;
		this.time = time;
		this.cpu = cpu;
		this.memory = memory;
		this.disk = disk;
		this.network = network;
		this.harperdb_processes = harperdb_processes;
	}
}

module.exports = SystemInformationObject;
