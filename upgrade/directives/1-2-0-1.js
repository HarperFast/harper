"use strict";
const path = require('os');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');


let sep = path.sep;
let directive = new upgrade_directive('1.2.0.1');

/*ver1_1_0_directive.relative_directory_paths.push(`staging`);
ver1_1_0_directive.relative_directory_paths.push(`staging${sep}scripts`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_nodes`); */

/*ver1_1_0_directive.environment_variables.push(
    new env_variable(`PROJECT_DIR`, ``, [])
); */


module.exports = directive;


