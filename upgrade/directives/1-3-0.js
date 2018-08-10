"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');


let sep = path.sep;
let directive = new upgrade_directive('1.3.0');

directive.relative_directory_paths.push(`test`);
directive.relative_directory_paths.push(`test${sep}tester`);
//ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_nodes`);

directive.environment_variables.push(
    new env_variable(`TEST_VAR`, `TEST VAL`, ['THIS IS A COMMENT'])
);

async function thisIsATest() {
    console.error('This is a test');
}


module.exports = directive;


