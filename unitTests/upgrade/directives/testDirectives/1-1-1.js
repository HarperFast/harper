"use strict";
const path = require('path');
const env_variable = require('../../../../upgrade/EnvironmentVariable');
const upgrade_directive = require('../../../../upgrade/UpgradeDirective');

let sep = path.sep;
let this_ver = '1.1.1';
let directive = new upgrade_directive(this_ver);

directive.relative_directory_paths.push(`processTest`);
directive.relative_directory_paths.push(`processTest${sep}scripts`);
directive.relative_directory_paths.push(`processTest${sep}envVars`);

directive.environment_variables.push(
    new env_variable(`PROCESS_DIR_TEST`, `I'm A Test`, [])
);
directive.environment_variables.push(
    new env_variable(`VERSION`, this_ver, [])
);

function doSomething() {
    //TODO: Think of something to do that can be traceable in a unit test
    console.log(`processing ${this_ver}`);
}

directive.functions.push(doSomething);

module.exports = directive;