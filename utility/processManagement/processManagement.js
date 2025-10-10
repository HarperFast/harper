'use strict';

const hdbTerms = require('../hdbTerms.ts');
const servicesConfig = require('./servicesConfig.js');
const envMangr = require('../environment/environmentManager.js');
const hdbLogger = require('../../utility/logging/harper_logger.js');
const { onMessageFromWorkers } = require('../../server/threads/manageThreads.js');
const fs = require('fs');
const path = require('node:path');
const terms = require('../hdbTerms');
const { setTimeout: delay } = require('node:timers/promises');
const { execFile, fork } = require('node:child_process');

module.exports = {
	start,
	restart,
	kill,
	startAllServices,
	startService,
	restartHdb,
	getHdbPid,
	cleanupChildrenProcesses,
	expectedRestartOfChildren,
};

onMessageFromWorkers((message) => {
	if (message.type === 'restart') envMangr.initSync(true);
});

let childProcesses = [];
const MAX_RESTARTS = 10;
let shuttingDown;
/**
 * Starts a service
 * @param procConfig
 * @returns void
 */
function start(procConfig, noKill = false) {
	const args = typeof procConfig.args === 'string' ? procConfig.args.split(' ') : procConfig.args;
	procConfig.silent = true;
	procConfig.detached = true;
	const subprocess = procConfig.script
		? fork(procConfig.script, args, procConfig)
		: execFile(procConfig.binFile, args, procConfig);
	subprocess.name = procConfig.name;
	subprocess.config = procConfig;
	subprocess.on('error', (code, message) => {
		console.error(code, message);
	});
	subprocess.on('exit', async (code) => {
		let index = childProcesses.indexOf(subprocess); // dead, remove it from processes to kill now
		if (index > -1) childProcesses.splice(index, 1);
		if (!shuttingDown && code !== 0) {
			procConfig.restarts = (procConfig.restarts || 0) + 1;
			// restart the child process
			if (procConfig.restarts < MAX_RESTARTS) {
				start(procConfig);
			}
		}
	});

	subprocess.stdout.on('data', (log) => hdbLogger.info(log.toString()));
	subprocess.stderr.on('data', (log) => hdbLogger.error(log.toString()));
	subprocess.unref();

	// if we are running in standard mode, then we want to clean up our child processes when we exit
	if (childProcesses.length === 0) {
		if (!noKill) {
			process.on('exit', cleanupChildrenProcesses);
			process.on('SIGINT', cleanupChildrenProcesses);
			process.on('SIGQUIT', cleanupChildrenProcesses);
			process.on('SIGTERM', cleanupChildrenProcesses);
		}
	}
	childProcesses.push(subprocess);
}
function cleanupChildrenProcesses(exit = true) {
	if (shuttingDown) return;
	shuttingDown = true;
	if (childProcesses.length === 0) return;
	hdbLogger.info('Killing child processes...');
	childProcesses.map((proc) => proc.kill());
	if (exit) process.exit(0);
	else return delay(2000); // give these processes some time to exit
}

/**
 * restart processes
 * @param serviceName
 * @returns {Promise<unknown>}
 */
function restart(serviceName) {
	expectedRestartOfChildren();
	for (let childProcess of childProcesses) {
		// kill the child process and let it (auto) restart
		if (childProcess.name === serviceName) {
			childProcess.kill();
		}
	}
}

/**
 * Reset the restart counts for all child processes because we are doing an intentional restart
 */
function expectedRestartOfChildren() {
	for (let childProcess of childProcesses) {
		if (childProcess.config) childProcess.config.restarts = 0; // reset the restart count
	}
}
/**
 * To restart HarperDB we use processManagement to fork a process and then call restart from that process.
 * We do this because we were seeing random errors when HDB was calling restart on itself.
 * @returns {Promise<void>}
 */
function restartHdb() {
	start(servicesConfig.generateRestart());
}

/**
 * Checks to see if Harper is currently running, returning the pid if it is
 * @returns {number|undefined}
 */
function getHdbPid() {
	const harperPath = envMangr.getHdbBasePath();
	if (!harperPath) return;
	const pidFile = path.join(harperPath, terms.HDB_PID_FILE);
	const hdbPid = readPidFile(pidFile);
	// If the pid file doesn't exist or the pid is the same as the current process, return.
	// In a Docker container, the pid is usually 1, and so if a previous process crashed, there will still
	// be a pid file with 1, even though this process is also 1 (and is running, but is not another harper process).
	if (!hdbPid || hdbPid === process.pid) return;
	if (isProcessRunning(hdbPid)) return hdbPid;
	// return undefined
}
function kill() {
	for (let process of childProcesses) {
		process.kill();
	}
	childProcesses = [];
	return;
}

/**
 * starts all services based on the servicesConfig
 * @returns {Promise<void>}
 */
function startAllServices() {
	start(servicesConfig.generateAllServiceConfigs());
}

/**
 * start a specific service
 * @param serviceName
 * @returns {Promise<void>}
 */
async function startService(serviceName, noKill = false) {
	let startConfig;
	serviceName = serviceName.toLowerCase();
	switch (serviceName) {
		case hdbTerms.PROCESS_DESCRIPTORS.HDB.toLowerCase():
			startConfig = servicesConfig.generateMainServerConfig();
			break;
		default:
			throw new Error(`Start service called with unknown service config: ${serviceName}`);
	}
	start(startConfig, noKill);
}

/**
 * Reads the HarperDB PID file and returns the PID as a number.
 * @param {string} pidFile - The path to the HarperDB PID file
 * @returns {number|null} - The PID as a number, or null if the file is not found or cannot be read
 */
function readPidFile(pidFile) {
	try {
		return Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
	} catch {
		return null;
	}
}

/**
 * Checks if a process is running by attempting to send a signal 0 to the process.
 * @param {number} pid - The process ID to check
 * @returns {boolean} - True if the process is running, false otherwise
 */
function isProcessRunning(pid) {
	try {
		// process.kill with signal 0 tests if process exists
		// throws error if process doesn't exist
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means process exists but we don't have permission
		// which still indicates the process is running
		if (err.code === 'EPERM') {
			return true;
		}
		return false;
	}
}
