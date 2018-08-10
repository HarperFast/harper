"use strict";
const path = require('os');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');


let sep = path.sep;
let directive = new upgrade_directive('1.2.005');

directive.relative_directory_paths.push(`vers${sep}vers005`);
/*ver1_1_0_directive.relative_directory_paths.push(`staging`);
ver1_1_0_directive.relative_directory_paths.push(`staging${sep}scripts`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_nodes`); */

/*ver1_1_0_directive.environment_variables.push(
    new env_variable(`PROJECT_DIR`, ``, [])
); */
directive.environment_variables.push(
    new env_variable(`VERS_005`, `VERS_005 VAL`, ['VERS_005 THIS IS A COMMENT'])
);

module.exports = directive;


