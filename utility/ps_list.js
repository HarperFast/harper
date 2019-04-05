'use strict';
const util = require('util');
const path = require('path');
const childProcess = require('child_process');
const exec_file = util.promisify(childProcess.execFile);

const TEN_MEGABYTES = 1000 * 1000 * 10;

module.exports = findPs;

/**
 * Module spawns child process to search for all running processes.
 * Cleans result, filters via process cmd and returns Promise<Array> with all instances of parameter name.
 * @param name
 * @returns {Promise<Array>}
 */
async function findPs(name) {
    let ps_list = {};

    try {
        await Promise.all(['comm', 'args', 'ppid', 'uid', '%cpu', '%mem'].map(async cmd => {
            let {stdout} = await exec_file('ps', ['wwxo', `pid,${cmd}`], {maxBuffer: TEN_MEGABYTES});

            for (let line of stdout.trim().split('\n').slice(1)) {
                line = line.trim();
                const [pid] = line.split(' ', 1);
                const val = line.slice(pid.length + 1).trim();

                if (ps_list[pid] === undefined) {
                    ps_list[pid] = {};
                }

                ps_list[pid][cmd] = val;
            }
        }));

    } catch (err) {
        throw err;
    }

    // Filter out inconsistencies as there might be race
    // issues due to differences in `ps` between the spawns
    let result = Object.entries(ps_list)
        .filter(([, value]) => value.comm && value.args && value.ppid && value.uid && value['%cpu'] && value['%mem'])
        .map(([key, value]) => ({
            pid: Number.parseInt(key, 10),
            name: path.basename(value.comm),
            cmd: value.args,
            ppid: Number.parseInt(value.ppid, 10),
            uid: Number.parseInt(value.uid, 10),
            cpu: Number.parseFloat(value['%cpu']),
            memory: Number.parseFloat(value['%mem'])
        }));

    let filtered_list = filterList(name, result);
    return filtered_list;
}

function filterList(name, ps_list) {
    let result = ps_list.filter(list => list.cmd.includes(name));
    return result;
}
