"use strict";
const path = require('path');
const env_variable = require('../../../../upgrade/EnvironmentVariable');
const upgrade_directive = require('../../../../upgrade/UpgradeDirective');

let sep = path.sep;
let this_ver = '1.1.0';
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

function doSomething1_1() {
    return 1;
}

directive.functions.push(doSomething1_1);

module.exports = directive;