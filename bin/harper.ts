#!/usr/bin/env node
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import logger from '../utility/logging/harper_logger.ts';
import * as cliOperations from './cliOperations.ts';
import { packageJson } from '../utility/packageUtils.js';
import checkNode from '../launchServiceScripts/utility/checkNodeVersion.js';
import * as hdbTerms from '../utility/hdbTerms.ts';
const { SERVICE_ACTIONS_ENUM } = hdbTerms as any;
if (typeof process.setSourceMapsEnabled === 'function') {
	process.setSourceMapsEnabled(true); // this is necessary for source maps to work, at least on the main thread.
}

const HELP = `
Usage: harperdb [command]

With no command, harper will simply run Harper (in the foreground)

By default, the CLI also supports certain Operation APIs. Specify the operation name and any required parameters, and omit the 'operation' command.

Commands:
copy-db <source> <target>       - Copies a database from source path to target path
dev <path>                      - Run the application in dev mode with debugging, foreground logging, no auth
install                         - Install harperdb
<api-operation> <param>=<value> - Run an API operation and return result to the CLI, not all operations are supported
login [target] [username]       - Login to a remote or local Harper instance
logout [target]                 - Logout from Harper and clear saved JWT
mcp [subcommand]                - MCP stdio bridge / print-config / doctor (see 'harper mcp help')
register                        - Register harperdb
renew-certs                     - Generate a new set of self-signed certificates
restart                         - Restart the harperdb background process
run <path>                      - Run the application in the specified path
start                           - Starts a separate background process for harperdb and CLI will exit
status                          - Print the status of Harper
stop                            - Stop the harperdb background process
help                            - Display this output
upgrade                         - Upgrade harperdb
version                         - Print the version
deploy                          - Deploy the application locally or remotely with target=<remote url>
`;

async function harper() {
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

	switch (service) {
		case SERVICE_ACTIONS_ENUM.HELP:
			return HELP;
		case SERVICE_ACTIONS_ENUM.START:
			return require('./run').launch();
		case SERVICE_ACTIONS_ENUM.INSTALL:
			return (require('./install').default || require('./install'))();
		case SERVICE_ACTIONS_ENUM.STOP:
			return (require('./stop').default || require('./stop'))().then(() => {
				process.exit(0);
			});
		case SERVICE_ACTIONS_ENUM.RESTART:
			return require('./restart').restart({});
		case SERVICE_ACTIONS_ENUM.VERSION:
			return packageJson.version;
		case SERVICE_ACTIONS_ENUM.UPGRADE:
			logger.setLogLevel(hdbTerms.LOG_LEVELS.INFO);
			// The require is here to better control the flow of imports when this module is called.
			return require('./upgrade.js')
				.upgrade(null)
				.then(() => 'Your instance of Harper is up to date!');
		case SERVICE_ACTIONS_ENUM.STATUS:
			return (require('./status').default || require('./status'))();
		case SERVICE_ACTIONS_ENUM.LOGIN: {
			const target = process.argv[3];
			const username = process.argv[4];
			const { login } = require('./login');
			return login(target, username);
		}
		case SERVICE_ACTIONS_ENUM.LOGOUT: {
			const target = process.argv[3];
			const { logout } = require('./logout');
			return logout(target);
		}
		case SERVICE_ACTIONS_ENUM.MCP: {
			const { runMcpCli } = require('./mcp');
			const code = await runMcpCli(process.argv.slice(3));
			process.exit(code);
		}
		// eslint-disable-next-line no-fallthrough
		case SERVICE_ACTIONS_ENUM.RENEWCERTS:
			return require('../security/keys')
				.renewSelfSigned()
				.then(() => 'Successfully renewed self-signed certificates');
		case SERVICE_ACTIONS_ENUM.COPYDB: {
			let sourceDb = process.argv[3];
			let targetDbPath = process.argv[4];
			return require('./copyDb').copyDb(sourceDb, targetDbPath);
		}
		case SERVICE_ACTIONS_ENUM.DEV:
			process.env.DEV_MODE = 'true';
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
				if (
					fs.existsSync(path.join(appFolder, hdbTerms.HARPER_CONFIG_FILE)) ||
					(fs.existsSync(path.join(appFolder, hdbTerms.HDB_CONFIG_FILE)) &&
						fs.existsSync(path.join(appFolder, 'database')))
				) {
					// This can be used to run HDB without a boot file
					process.env.ROOTPATH = appFolder;
				} else {
					process.env.RUN_HDB_APP = appFolder;
				}
			} else if (fs.existsSync(hdbTerms.HDB_COMPONENT_CONFIG_FILE) || fs.existsSync('schema.graphql')) {
				console.warn(
					`It appears you are running Harper in an application directory, but did not specify the path. I'll go ahead and run the application for you since that's probably what you meant. But to avoid this warning in the future, run applications in the current directory like this: "harper ${service} ."`
				);
				process.env.RUN_HDB_APP = process.cwd();
			} else if (fs.existsSync(hdbTerms.HARPER_CONFIG_FILE) || fs.existsSync(hdbTerms.HDB_CONFIG_FILE)) {
				console.warn(
					`It appears you are running Harper in a root data directory, but did not specify the path. I'll go ahead and run Harper with its root path set to "." for you since that's probably what you meant. But to avoid this warning in the future, run it like this: "harper ${service} ."`
				);
				process.env.ROOTPATH = process.cwd();
			}
		}
		// fall through
		case undefined: // run harperdb in the foreground in standard mode
			return require('./run').main();
		default:
			const cliApiOp = cliOperations.buildRequest();
			logger.trace('calling cli operations with:', cliApiOp);
			await cliOperations.cliOperations(cliApiOp);
			return;
	}
}
export { harper };
if (require.main === module) {
	harper()
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
}
