"use strict"
const os = require('os');
const install_directive = require('installDirective');

let sep = os.EOL;
let ver1_1_0_directive = new install_directive.installDirective('1_1_0');

ver1_1_0_directive.schema_relative_paths.push(`staging`);
ver1_1_0_directive.schema_relative_paths.push(`staging${sep}scripts`);
ver1_1_0_directive.schema_relative_paths.push(`staging${sep}symlink_eraser`);
ver1_1_0_directive.schema_relative_paths.push(`staging${sep}schema_op_queue`);
ver1_1_0_directive.schema_relative_paths.push(`staging${sep}schema_op_log`);
ver1_1_0_directive.schema_relative_paths.push(`backup`);
ver1_1_0_directive.schema_relative_paths.push(`trash`);
ver1_1_0_directive.schema_relative_paths.push(`keys`);
ver1_1_0_directive.schema_relative_paths.push(`log`);
ver1_1_0_directive.schema_relative_paths.push(`config`);
ver1_1_0_directive.schema_relative_paths.push(`doc`);
ver1_1_0_directive.schema_relative_paths.push(`schema`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_license`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_attribute`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_schema`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_table`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_table${sep}schema`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_table${sep}name`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_table${sep}hash_attribute`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_table${sep}residence`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_user`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_role`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_queue`);
ver1_1_0_directive.schema_relative_paths.push(`schema${sep}system${sep}hdb_nodes`);

ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable(`PROJECT_DIR`, ``, [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable(`HDB_ROOT`, ``, [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("HTTP_PORT", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("HTTPS_PORT", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("CERTIFICATE", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("PRIVATE_KEY", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("HTTPS_ON", "FALSE", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("HTTP_ON", "TRUE", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("CORS_ON", "TRUE", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("CORS_WHITELIST", "", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("SERVER_TIMEOUT_MS", "120000", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("LOG_LEVEL", "error", [
        "LOGGER = 1 Uses the WINSTON logger.",
        "LOGGER = 2 Uses the more performant PINO logger."
    ])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("LOGGER", "1", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("LOG_PATH", "/log/hdb_log.log", [])
);
ver1_1_0_directive.environment_variables.push(
    new install_directive.environmentVariable("NODE_ENV", "production", [])
);

module.exports = {
  "paths": relative_paths
}



