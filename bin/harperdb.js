#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utility/logging/harper_logger.js');
const cliOperations = require('./cliOperations.js');
const { packageJson } = require('../utility/packageUtils.js');
const checkNode = require('../launchServiceScripts/utility/checkNodeVersion.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const { SERVICE_ACTIONS_ENUM } = hdbTerms;

const HELP = `
Usage: harperdb [command]

With no command, harperdb will simply run HarperDB (in the foreground)

By default, the CLI also supports certain Operation APIs. Specify the operation name and any required parameters, and omit the 'operation' command.

Commands:
copy-db <source> <target>       - Copies a database from source path to target path
dev <path>                      - Run the application in dev mode with debugging, foreground logging, no auth
install                         - Install harperdb
<api-operation> <param>=<value> - Run an API operation and return result to the CLI, not all operations are supported
register                        - Register harperdb
renew-certs                     - Generate a new set of self-signed certificates
restart                         - Restart the harperdb background process
run <path>                      - Run the application in the specified path
start                           - Starts a separate background process for harperdb and CLI will exit
status                          - Print the status of HarperDB
stop                            - Stop the harperdb background process
help                            - Display this output
upgrade                         - Upgrade harperdb
version                         - Print the version
`;

async function harperdb() {
	let nodeResults = checkNode();

	if (nodeResults) {
		if (nodeResults.error) {
			console.error(nodeResults.error);
			logger.error(nodeResults.error);
			return;
		} else if (nodeResults.warn) {
			console.warn(nodeResults.warn);
			logger.warn(nodeResults.warn);
		}
	}

	let service;

	if (process.argv && process.argv[2] && !process.argv[2].startsWith('-')) {
		service = process.argv[2].toLowerCase();
	}

	const cliApiOp = cliOperations.buildRequest();
	if (cliApiOp.operation) service = SERVICE_ACTIONS_ENUM.OPERATION;

	switch (service) {
		case SERVICE_ACTIONS_ENUM.OPERATION:
			logger.trace('calling cli operations with:', cliApiOp);
			await cliOperations.cliOperations(cliApiOp);
			return;
		case SERVICE_ACTIONS_ENUM.START:
			return require('./run.js').launch();
		case SERVICE_ACTIONS_ENUM.INSTALL:
			return require('./install.js')();
		case SERVICE_ACTIONS_ENUM.STOP:
			return require('./stop.js')().then(() => {
				process.exit(0);
			});
		case SERVICE_ACTIONS_ENUM.RESTART:
			return require('./restart.js').restart({});
		case SERVICE_ACTIONS_ENUM.VERSION:
			return packageJson.version;
		case SERVICE_ACTIONS_ENUM.UPGRADE:
			logger.setLogLevel(hdbTerms.LOG_LEVELS.INFO);
			// The require is here to better control the flow of imports when this module is called.
			return require('./upgrade.js')
				.upgrade(null)
				.then(() => 'Your instance of HarperDB is up to date!');
		case SERVICE_ACTIONS_ENUM.STATUS:
			return require('./status.js')();
		case SERVICE_ACTIONS_ENUM.RENEWCERTS:
			return require('../security/keys.js')
				.renewSelfSigned()
				.then(() => 'Successfully renewed self-signed certificates');
		case SERVICE_ACTIONS_ENUM.COPYDB: {
			let sourceDb = process.argv[3];
			let targetDbPath = process.argv[4];
			return require('./copyDb.ts').copyDb(sourceDb, targetDbPath);
		}
		case SERVICE_ACTIONS_ENUM.DEV:
			process.env.DEV_MODE = true;
		// fall through
		case SERVICE_ACTIONS_ENUM.RUN: {
			// Run a specific application folder
			let appFolder = process.argv[3];
			if (appFolder && appFolder[0] !== '-') {
				if (!fs.existsSync(appFolder)) {
					throw new Error(`The folder ${appFolder} does not exist`);
				}
				if (!fs.statSync(appFolder).isDirectory()) {
					throw new Error(`The path ${appFolder} is not a folder`);
				}
				appFolder = fs.realpathSync(appFolder);
				if (fs.existsSync(path.join(appFolder, hdbTerms.HDB_CONFIG_FILE))) {
					// This can be used to run HDB without a boot file
					process.env.ROOTPATH = appFolder;
				} else {
					process.env.RUN_HDB_APP = appFolder;
				}
			}
		}
		// fall through
		case undefined: // run harperdb in the foreground in standard mode
			return require('./run.js').main();
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
