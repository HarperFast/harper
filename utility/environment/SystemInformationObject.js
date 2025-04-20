'use strict';

class SystemInformationObject {
	constructor(system, time, cpu, memory, disk, network, harperdbProcesses) {
		this.system = system;
		this.time = time;
		this.cpu = cpu;
		this.memory = memory;
		this.disk = disk;
		this.network = network;
		this.harperdb_processes = harperdbProcesses;
	}
}

module.exports = SystemInformationObject;
