"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');
const os = require('os');

let sep = path.sep;
let directive = new upgrade_directive('1.3.1');
let num_cores = 4;
try {
    num_cores = os.cpus().length;
} catch(err) {
    //No-op, should only get here in the case of android.  Defaulted to 4.
}

directive.environment_variables.push(
    new env_variable(`MAX_HDB_PROCESSES`, `${num_cores}`, ["Set the max number of processes HarperDB will kick off.  This can also be limited by number of cores and licenses."])
);

module.exports = directive;


