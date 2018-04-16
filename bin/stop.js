#!/usr/bin/env node
const spawn = require('child_process').spawn;
const os = require("os");
const readline = require('readline');

const HDB_PROC_NAME = 'hdb_express.js';
const ps = spawn('ps', ['xo', 'user,pid,args']);
const hdb_grep = spawn('grep', [HDB_PROC_NAME]);

const DATA_MSG_NAME = 'data';
const CLOSE_MSG_NAME = 'close';

module.exports = {
    stop: stop
};
function stop() {
    let username = os.userInfo().username;
    ps.stdout.on(DATA_MSG_NAME, (data) => {
        hdb_grep.stdin.write(data);
    });

    hdb_grep.stdout.on(DATA_MSG_NAME, (data) => {
        // This is where the ps data comes in, it gets passed to the readline.
    });

    // result from the grep ends up here
    readline.createInterface({
        input     : hdb_grep.stdout,
        terminal  : false
    }).on('line', function(line) {
        if(line && line.length > 0) {
            let split_line = line.split(' ');
            try {
                // Send kill signal to all hdb processes.
                if(split_line[0] === username || split_line[0] === root) {
                    process.kill(split_line[1]);
                } else {
                    console.error('You must be logged in as the HDB installed user or root to stop HarperDB.')
                }
            } catch (e) {
                console.error("Tried to stop HarperDB, error: " + e);
            }
        }
    });

    ps.stderr.on(DATA_MSG_NAME, (data) => {
        console.error(`ps stderr: ${data}`);
    });

    ps.on(DATA_MSG_NAME, (code) => {
        if (code !== 0) {
            console.log(`ps process exited with code ${code}`);
        }
        hdb_grep.stdin.end();
    });

    hdb_grep.stderr.on(DATA_MSG_NAME, (data) => {
        console.error(`grep stderr: ${data}`);
    });

    hdb_grep.on(CLOSE_MSG_NAME, (code) => {
        if (code !== 0) {
            console.log(`grep process exited with code ${code}`);
        }
    });
};



