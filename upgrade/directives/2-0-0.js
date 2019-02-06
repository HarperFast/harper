"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');

let sep = path.sep;
let directive = new upgrade_directive('2.0.0');

directive.environment_variables.push(
    new env_variable(`MAX_HDB_PROCESSES`, `4`, ["Set the max number of processes HarperDB will kick off.  This can also be limited by number of cores and licenses."])
);

module.exports = directive;


