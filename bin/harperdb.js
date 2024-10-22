#!/usr/bin/env node
'use strict';

const run_clone = process.env.HDB_LEADER_URL || process.argv.includes('--HDB_LEADER_URL');
if (run_clone) {
	const env_mgr = require('../utility/environment/environmentManager');
	env_mgr.setCloneVar(true);
}

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utility/logging/harper_logger');
const cli_operations = require('./cliOperations');
const version = require('./version');
const check_node = require('../launchServiceScripts/utility/checkNodeVersion');
const hdb_terms = require('../utility/hdbTerms');
const { SERVICE_ACTIONS_ENUM, PACKAGE_ROOT } = hdb_terms;

const HELP = `
Usage: harperdb [command]

With no command, harperdb will simply run HarperDB (in the foreground)

By default, the CLI also supports all Operation APIs. Specify the operation name and any required parameters, and omit the 'operation' command.

Commands:
copy-db <source> <target>       - Copies a database from source path to target path
dev <path>                      - Run the application in dev mode with debugging, foreground logging, no auth
install                         - Install harperdb
operation <op> <param>=<value>  - Run an API operation and return result to the CLI, not all operations are supported
register                        - Register harperdb
renew-certs                     - Generate a new set of self-signed certificates
restart                         - Restart the harperdb background process
run <path>                      - Run the application in the specified path
start                           - Starts a separate background process for harperdb and CLI will exit
status                          - Print the status of HarperDB and clustering
stop                            - Stop the harperdb background process
help                            - Display this output
upgrade                         - Upgrade harperdb
version                         - Print the version
`;

async function harperdb() {
	let node_results = check_node();

	if (node_results) {
		if (node_results.error) {
			console.error(node_results.error);
			logger.error(node_results.error);
			return;
		} else if (node_results.warn) {
			console.warn(node_results.warn);
			logger.warn(node_results.warn);
		}
	}

	let service;

	if (!fs.existsSync(path.join(PACKAGE_ROOT, 'bin'))) {
		logger.error(`Missing \`bin\` directory at ${PACKAGE_ROOT}`);
		process.exit(0);
	}

	if (process.argv && process.argv[2] && !process.argv[2].startsWith('-')) {
		service = process.argv[2].toLowerCase();
	}

	let cli_api_op;
	if (!run_clone) {
		cli_api_op = cli_operations.buildRequest();
		if (cli_api_op.operation) service = SERVICE_ACTIONS_ENUM.OPERATION;
	}

	switch (service) {
		case SERVICE_ACTIONS_ENUM.OPERATION:
			logger.trace('calling cli operations with:', cli_api_op);
			return cli_operations.cliOperations(cli_api_op);
		case SERVICE_ACTIONS_ENUM.START:
			return run_clone ? require('../utility/cloneNode/cloneNode')(true) : require('./run').launch();
		case SERVICE_ACTIONS_ENUM.INSTALL:
			return require('./install')().then(() => {
				return require('./run').main(true);
			});
		case SERVICE_ACTIONS_ENUM.REGISTER:
			return require('./register').register();
		case SERVICE_ACTIONS_ENUM.STOP:
			return require('./stop')().then(() => {
				process.exit(0);
			});
		case SERVICE_ACTIONS_ENUM.RESTART:
			return require('./restart').restart({});
		case SERVICE_ACTIONS_ENUM.VERSION:
			return version.version();
		case SERVICE_ACTIONS_ENUM.UPGRADE:
			logger.setLogLevel(hdb_terms.LOG_LEVELS.INFO);
			// The require is here to better control the flow of imports when this module is called.
			return require('./upgrade')
				.upgrade(null)
				.then(() => 'Your instance of HarperDB is up to date!');
		case SERVICE_ACTIONS_ENUM.STATUS:
			return require('./status')();
		case SERVICE_ACTIONS_ENUM.RENEWCERTS:
			return require('../security/keys')
				.renewSelfSigned()
				.then(() => 'Successfully renewed self-signed certificates');
		case SERVICE_ACTIONS_ENUM.COPYDB: {
			let source_db = process.argv[3];
			let target_db_path = process.argv[4];
			return require('./copyDb').copyDb(source_db, target_db_path);
		}
		case SERVICE_ACTIONS_ENUM.DEV:
			process.env.DEV_MODE = true;
		// fall through
		case SERVICE_ACTIONS_ENUM.RUN: {
			// Run a specific application folder
			let app_folder = process.argv[3];
			if (app_folder && app_folder[0] !== '-') {
				if (!fs.existsSync(app_folder)) {
					throw new Error(`The folder ${app_folder} does not exist`);
				}
				if (!fs.statSync(app_folder).isDirectory()) {
					throw new Error(`The path ${app_folder} is not a folder`);
				}
				app_folder = fs.realpathSync(app_folder);
				if (fs.existsSync(path.join(app_folder, hdb_terms.HDB_CONFIG_FILE))) {
					// This can be used to run HDB without a boot file
					process.env.ROOTPATH = app_folder;
				} else {
					process.env.RUN_HDB_APP = app_folder;
				}
			}
		}
		// fall through
		case undefined: // run harperdb in the foreground in standard mode
			return run_clone ? require('../utility/cloneNode/cloneNode')() : require('./run').main();
		// eslint-disable-next-line sonarjs/prefer-default-last
		default:
			console.warn(`The "${service}" command is not understood.`);
		// fall through
		case SERVICE_ACTIONS_ENUM.HELP:
			return HELP;
	}
}

harperdb()
	.then((message) => {
		if (message) {
			console.log(message);
			logger.notify(message);
		}
		// Intentionally not calling `process.exit(0);` so if a CLI
		// command resulted in a long running process (aka `run`),
		// it continues to run.
	})
	.catch((error) => {
		if (error) {
			console.error(error);
			logger.error(error);
		}
		process.exit(1);
	});
