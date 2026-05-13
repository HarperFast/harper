#!/usr/bin/env node
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import logger from '../utility/logging/harper_logger.ts';
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

Documentation: https://docs.harperdb.io/

By default, the CLI also supports certain Operation APIs. Specify the operation name and any required parameters, and omit the 'operation' command.

Commands:
copy-db <source> <target>       - Copies a database from source path to target path
dev <path>                      - Run the application in dev mode with debugging, foreground logging, no auth
install                         - Install harperdb
<api-operation> <param>=<value> - Run an API operation and return result to the CLI, not all operations are supported
login [target] [username]       - Login to a remote or local Harper instance
logout [target]                 - Logout from Harper and clear saved JWT
mcp [subcommand]                - MCP stdio bridge / print-config / doctor (see 'harper mcp help')
			return login(target, username);
		}
		case SERVICE_ACTIONS_ENUM.LOGOUT: {
			const target = process.argv[3];
			const { logout } = await import('./logout.ts');
			return logout(target);
		}
		case SERVICE_ACTIONS_ENUM.MCP: {
			const { runMcpCli } = await import('./mcp/index.ts');
			const code = await runMcpCli(process.argv.slice(3));
			process.exit(code);
		}
		// eslint-disable-next-line no-fallthrough
		case SERVICE_ACTIONS_ENUM.RENEWCERTS:
			return (await import('../security/keys.ts'))
				.renewSelfSigned()
				.then(() => 'Successfully renewed self-signed certificates');
		case SERVICE_ACTIONS_ENUM.COPYDB: {
			let sourceDb = process.argv[3];
			let targetDbPath = process.argv[4];
			return (await import('./copyDb.ts')).copyDb(sourceDb, targetDbPath);
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
		case undefined: {
			// run harperdb in the foreground in standard mode.
			// runStartup() is drained inside run.ts main() after initialize().
			await initEnv();
			const mod = await import('./run.ts');
			return mod.main();
		}
		default: {
			const cliOperations = await import('./cliOperations.ts');
			const cliApiOp = cliOperations.buildRequest();
			logger.trace('calling cli operations with:', cliApiOp);
			await cliOperations.cliOperations(cliApiOp);
			return;
		}
	}
}
export { harper };
// In CJS (dist), `module` is defined and we check the entry. In ESM (typestrip),
// `module` is undefined; this file is only run directly as a CLI, so treat as main.
const isEntry = typeof module === 'undefined' || require.main === module;
if (isEntry) {
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
