"use strict";
const path = require('path');
const env_variable = require('../../../../../upgrade/EnvironmentVariable');
const upgrade_directive = require('../../../../../upgrade/UpgradeDirective');

let sep = path.sep;
let this_ver = '1.1.0';
let ver1_1_0_directive = new upgrade_directive(this_ver);

ver1_1_0_directive.relative_directory_paths.push(`processTest`);
ver1_1_0_directive.relative_directory_paths.push(`processTest${sep}scripts`);
ver1_1_0_directive.relative_directory_paths.push(`processTest${sep}envVars`);

ver1_1_0_directive.environment_variables.push(
    new env_variable(`PROCESS_DIR_TEST`, `I'm A Test`, [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable(`VERSION`, this_ver, [])
);

function doSomething() {
    //TODO: Think of something to do that can be traceable in a unit test
    console.log(`processing ${this_ver}`);
}

ver1_1_0_directive.functions.push(doSomething);

module.exports = ver1_1_0_directive;