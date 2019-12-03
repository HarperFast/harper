"use strict";
const path = require('os');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');
let directives = [];
let directive_1_1_0 = new upgrade_directive('1.1.0');
let directive_1_1_1 = new upgrade_directive('1.1.1');
let directive_1_1_2= new upgrade_directive('1.1.2');

/*ver1_1_0_directive.relative_directory_paths.push(`staging`);
ver1_1_0_directive.relative_directory_paths.push(`staging${sep}scripts`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_nodes`); */

/*ver1_1_0_directive.environment_variables.push(
    new env_variable(`PROJECT_DIR`, ``, [])
); */
directive_1_1_0.change_description = `Version 1.0`;
directives.push(directive_1_1_0);
directive_1_1_1.change_description = "Version 1.1.1";
directives.push(directive_1_1_1);
directive_1_1_2.change_description = "Version 1.1.2";
directives.push(directive_1_1_2);

module.exports = directives;


