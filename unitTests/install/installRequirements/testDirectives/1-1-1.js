"use strict";
const path = require('path');
const env_variable = require('../../../../utility/install/installRequirements/EnvironmentVariable');
const upgrade_directive = require('../../../../utility/install/installRequirements/UpgradeDirective');

let sep = path.sep;
let ver1_1_1_directive = new upgrade_directive('1.1.1');

ver1_1_1_directive.relative_directory_paths.push(`processTest`);
ver1_1_1_directive.relative_directory_paths.push(`processTest${sep}scripts`);
ver1_1_1_directive.relative_directory_paths.push(`processTest${sep}envVars`);

ver1_1_1_directive.environment_variables.push(
    new env_variable(`PROCESS_DIR_TEST`, `I'm A Test`, [])
);
ver1_1_1_directive.environment_variables.push(
    new env_variable(`VERSION`, `1.1.1`, [])
);

function doSomething() {
    //TODO: Think of something to do that can be traceable in a unit test
    console.log("HI THERE");
}

ver1_1_1_directive.functions.push(doSomething);

module.exports = ver1_1_1_directive;