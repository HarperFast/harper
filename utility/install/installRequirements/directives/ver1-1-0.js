"use strict";
const os = require('os');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');


let sep = os.EOL;
let ver1_1_0_directive = new upgrade_directive('1_1_0');

ver1_1_0_directive.relative_directory_paths.push(`staging`);
ver1_1_0_directive.relative_directory_paths.push(`staging${sep}scripts`);
ver1_1_0_directive.relative_directory_paths.push(`staging${sep}symlink_eraser`);
ver1_1_0_directive.relative_directory_paths.push(`staging${sep}schema_op_queue`);
ver1_1_0_directive.relative_directory_paths.push(`staging${sep}schema_op_log`);
ver1_1_0_directive.relative_directory_paths.push(`backup`);
ver1_1_0_directive.relative_directory_paths.push(`trash`);
ver1_1_0_directive.relative_directory_paths.push(`keys`);
ver1_1_0_directive.relative_directory_paths.push(`log`);
ver1_1_0_directive.relative_directory_paths.push(`config`);
ver1_1_0_directive.relative_directory_paths.push(`doc`);
ver1_1_0_directive.relative_directory_paths.push(`schema`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_license`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_attribute`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_schema`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_table`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_table${sep}schema`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_table${sep}name`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_table${sep}hash_attribute`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_table${sep}residence`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_user`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_role`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_queue`);
ver1_1_0_directive.relative_directory_paths.push(`schema${sep}system${sep}hdb_nodes`);

ver1_1_0_directive.environment_variables.push(
    new env_variable(`PROJECT_DIR`, ``, [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable(`HDB_ROOT`, ``, [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("HTTP_PORT", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("HTTPS_PORT", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("CERTIFICATE", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("PRIVATE_KEY", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("HTTPS_ON", "FALSE", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("HTTP_ON", "TRUE", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("CORS_ON", "TRUE", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("CORS_WHITELIST", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("SERVER_TIMEOUT_MS", "120000", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("LOG_LEVEL", "error", [
        "LOGGER = 1 Uses the WINSTON logger.",
        "LOGGER = 2 Uses the more performant PINO logger."
    ])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("LOGGER", "1", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("LOG_PATH", "/log/hdb_log.log", [])
);
ver1_1_0_directive.environment_variables.push(
    new env_variable("NODE_ENV", "production", [])
);

module.exports = ver1_1_0_directive;


