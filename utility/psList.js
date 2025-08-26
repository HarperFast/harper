'use strict';
const util = require('util');
const path = require('path');
const childProcess = require('child_process');
const execFile = util.promisify(childProcess.execFile);

const TEN_MEGABYTES = 1000 * 1000 * 10;

module.exports = {
	findPs,
};

/**
 * Module spawns child process to search for all running processes.
 * Cleans result, filters via process cmd and returns Promise<Array> with all instances of parameter name.
 * @param name
 * @returns {Promise<Array>}
 */
async function findPs(name) {
	let psList = {};

	try {
		await Promise.all(
			['comm', 'args', 'ppid', 'uid', '%cpu', '%mem'].map(async (cmd) => {
				let { stdout } = await execFile('ps', ['wwxo', `pid,${cmd}`], { maxBuffer: TEN_MEGABYTES });

				for (let line of stdout.trim().split('\n').slice(1)) {
					line = line.trim();
					const [pid] = line.split(' ', 1);
					const val = line.slice(pid.length + 1).trim();

					if (psList[pid] === undefined) {
						psList[pid] = {};
					}

					psList[pid][cmd] = val;
				}
			})
		);
	} catch (err) {
		throw err;
	}

	// Filter out inconsistencies as there might be raceS
	// issues due to differences in `ps` between the spawns
	return Object.entries(psList)
		.filter(
			([, value]) =>
				value.comm &&
				value.args &&
				value.ppid &&
				value.uid &&
				value['%cpu'] &&
				value['%mem'] &&
				value.args.includes(name)
		)
		.map(([key, value]) => ({
			pid: Number.parseInt(key, 10),
			name: path.basename(value.comm),
			cmd: value.args,
			ppid: Number.parseInt(value.ppid, 10),
			uid: Number.parseInt(value.uid, 10),
			cpu: Number.parseFloat(value['%cpu']),
			memory: Number.parseFloat(value['%mem']),
		}));
}
