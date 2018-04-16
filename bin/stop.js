#!/usr/bin/env node
const spawn = require('child_process').spawn;
const os = require("os");
const readline = require('readline');

const HDB_PROC_NAME = 'hdb_express.js';
const ps = spawn('ps', ['xo', 'user,pid,args']);
const hdb_grep = spawn('grep', [HDB_PROC_NAME]);

module.exports = {
    stop: stop
};
function stop(callback) {

    let username = os.userInfo().username;
    let foundUsers = [];
    ps.stdout.on('data', (data) => {
        hdb_grep.stdin.write(data);
        //console.log(`stdout: ${data}`);
    })
    hdb_grep.stdout.on('data', (data) => {
        // This is where the ps data comes in
    });

    // result from the grep ends up here
    readline.createInterface({
        input     : hdb_grep.stdout,
        terminal  : false
    }).on('line', function(line) {
        console.log(line);
        if(line && line.length > 0) {
            line.split(' ');
            foundUsers.push({user: line[0], pid:line[1]});
            try {
                // Send kill signal to all hdb processes.
                if(line[0] === username || line[0] === root) {
                    process.kill(line[1]);
                } else {
                    console.error('You must be logged in as the HDB installed user or root to stop HarperDB.')
                }
            } catch (e) {
                console.error("Tried to stop HarperDB, error: " + e);
            }
        }
    });

    ps.stderr.on('data', (data) => {
        console.log(`ps stderr: ${data}`);
    });

    ps.on('close', (code) => {
        if (code !== 0) {
            console.log(`ps process exited with code ${code}`);
        }
        hdb_grep.stdin.end();
    });

    hdb_grep.stderr.on('data', (data) => {
        console.log(`grep stderr: ${data}`);
    });

    hdb_grep.on('close', (code) => {
        if (code !== 0) {
            console.log(`grep process exited with code ${code}`);
        }
    });
};



