#!/usr/bin/env node
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import logger from '../utility/logging/harper_logger.ts';
import { help } from './help.ts';
import { packageJson, RUNTIME_SRC_ROOT, RUNTIME_FILE_EXT } from '../utility/packageUtils.js';
import checkNode from '../launchServiceScripts/utility/checkNodeVersion.js';
import * as hdbTerms from '../utility/hdbTerms.ts';
const { SERVICE_ACTIONS_ENUM, OPERATIONS_ENUM } = hdbTerms as any;
if (typeof process.setSourceMapsEnabled === 'function') {
	process.setSourceMapsEnabled(true); // this is necessary for source maps to work, at least on the main thread.
}

/**
 * Format a CLI error for the terminal. Expected, user-facing errors (a `ClientError` from an
 * operation — bad args, not found, a locked backup repo — which carry a numeric `statusCode`) get
 * just their message, not a Node stack trace. A genuinely unexpected error keeps its stack so a bug
 * is still debuggable. Mirrors the clean `error: <message>` output of a forwarded operation.
 */
export function formatCliError(error: any): string {
	const message = `error: ${error?.message ?? error}`;
	if (error?.stack && typeof error?.statusCode !== 'number') return `${message}\n${error.stack}`;
	return message;
}

/**
 * Whether a `-h`/`--help` anywhere in `argv` should print the top-level help. Returns false for the
 * subcommands that own their own `--help` — mcp and agent/chat parse `process.argv.slice(3)`
 * themselves downstream — so `harper mcp --help` reaches the mcp handler instead of this help.
 */
export function wantsTopLevelHelp(argv: readonly string[], service: string | undefined): boolean {
	const delegatesHelp =
		service === SERVICE_ACTIONS_ENUM.MCP ||
		service === SERVICE_ACTIONS_ENUM.AGENT ||
		service === SERVICE_ACTIONS_ENUM.CHAT;
	return !delegatesHelp && (argv.includes('-h') || argv.includes('--help'));
}

// Load configuration before a subcommand's module-level config reads.
async function initEnv() {
	const env = await import('../utility/environment/environmentManager.ts');
	env.initSync();
}

/**
 * Resolve a default-exported function from a dynamically-imported module that
 * may have been loaded from a .ts source (ESM: `mod.default` is the function)
 * or a tsc-compiled .js (CJS-wrapped: `mod.default` is the CJS exports object
 * and `mod.default.default` is the function).
 */
function getDefaultExport(mod: any): any {
	if (typeof mod === 'function') return mod;
	if (typeof mod.default === 'function') return mod.default;
	if (typeof mod.default?.default === 'function') return mod.default.default;
	return mod.default ?? mod;
}

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

	if (process.argv?.[2] && !process.argv[2].startsWith('-')) {
		service = process.argv[2].toLowerCase();
	}

	if (wantsTopLevelHelp(process.argv, service)) {
		return help();
	}

	switch (service) {
		case SERVICE_ACTIONS_ENUM.HELP:
			return help();
		case SERVICE_ACTIONS_ENUM.START: {
			await initEnv();
			const mod = await import('./run.ts');
			// runStartup() is drained inside run.ts main() after initialize()
			// completes, so server.X singletons and auth's table() resolution
			// see a populated env / installed hdbBasePath.
			return mod.launch();
		}
		case SERVICE_ACTIONS_ENUM.INSTALL: {
			return getDefaultExport(await import('./install.ts'))();
		}
		case SERVICE_ACTIONS_ENUM.STOP: {
			await initEnv();
			return getDefaultExport(await import('./stop.ts'))().then(() => {
				process.exit(0);
			});
		}
		case SERVICE_ACTIONS_ENUM.RESTART:
			await initEnv();
			return (await import('./restart.ts')).restart({});
		case SERVICE_ACTIONS_ENUM.VERSION:
			return packageJson.version;
		case SERVICE_ACTIONS_ENUM.UPGRADE:
			await initEnv();
			logger.setLogLevel(hdbTerms.LOG_LEVELS.INFO);
			// The require is here to better control the flow of imports when this module is called.
			return (await import('./upgrade.ts')).upgrade(null).then(() => 'Your instance of Harper is up to date!');
		case SERVICE_ACTIONS_ENUM.STATUS: {
			await initEnv();
			return getDefaultExport(await import('./status.ts'))();
		}
		case SERVICE_ACTIONS_ENUM.LOGIN: {
			const args = process.argv.slice(3);
			const forCi = args.includes('--for-ci');
			// Flags are filtered out so they can appear anywhere without being mistaken for the
			// positional target/username.
			const [target, username] = args.filter((arg) => !arg.startsWith('-'));
			const { login } = await import('./login.ts');
			return login(target, username, { forCi });
		}
		case SERVICE_ACTIONS_ENUM.LOGOUT: {
			const target = process.argv[3];
			const { logout } = await import('./logout.ts');
			return logout(target);
		}
		case SERVICE_ACTIONS_ENUM.MCP: {
			await initEnv();
			const { runMcpCli } = await import('./mcp/index.ts');
			const code = await runMcpCli(process.argv.slice(3));
			process.exit(code);
		}
		case SERVICE_ACTIONS_ENUM.CHAT:
		case SERVICE_ACTIONS_ENUM.AGENT: {
			await initEnv();
			const { runAgentCli } = await import('./agentCli.ts');
			const code = await runAgentCli(process.argv.slice(3));
			process.exit(code);
		}
		// eslint-disable-next-line no-fallthrough
		case SERVICE_ACTIONS_ENUM.RENEWCERTS:
			await initEnv();
			return (await import('../security/keys.ts'))
				.renewSelfSigned()
				.then(() => 'Successfully renewed self-signed certificates');
		case SERVICE_ACTIONS_ENUM.COPYDB: {
			await initEnv();
			let sourceDb = process.argv[3];
			let targetDbPath = process.argv[4];
			return (await import('./copyDb.ts')).copyDb(sourceDb, targetDbPath, { blobs: 'copy' });
		}
		case OPERATIONS_ENUM.CREATE_BACKUP:
		case OPERATIONS_ENUM.LIST_BACKUPS:
		case OPERATIONS_ENUM.VERIFY_BACKUP:
		case OPERATIONS_ENUM.DELETE_BACKUP:
		case OPERATIONS_ENUM.PURGE_BACKUPS:
		case OPERATIONS_ENUM.GET_BACKUP:
		case OPERATIONS_ENUM.RESTORE_BACKUP:
			await initEnv();
			return (await import('./backup.ts')).runBackupCommand(service);
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
			await initEnv();
			const cliOperations = await import('./cliOperations.ts');
			const cliApiOp = cliOperations.buildRequest();
			// `harper deploy setup=true` provisions an encrypted deploy credential (client-side sealed
			// token) rather than deploying — an interactive flow, not a single operation call.
			if (cliApiOp.operation === 'deploy_component' && cliApiOp.setup) {
				const { deploySetup } = await import('./deploySetup.ts');
				await deploySetup(cliApiOp);
				return;
			}
			// A `token=` that didn't reach the setup flow is a mistyped invocation, not a deploy field —
			// `harper deploy setup token=…` (no `=true`) parses `setup` as a bare word that buildRequest
			// drops, so it would otherwise proceed as an ordinary deploy carrying a live credential it has
			// no use for. Refuse rather than deploy: the token is redacted and never sent either way, but
			// silently ignoring it would leave the user believing a credential was provisioned.
			if (cliApiOp.operation === 'deploy_component' && cliApiOp.token !== undefined) {
				// statusCode so formatCliError prints this as a one-line hint rather than a stack trace —
				// it's a typo, not a crash.
				throw Object.assign(
					new Error('`token=` is only valid with `setup=true` — did you mean `harper deploy setup=true`?'),
					{ statusCode: 400 }
				);
			}
			logger.trace('calling cli operations with:', cliOperations.redactCredentials(cliApiOp));
			await cliOperations.cliOperations(cliApiOp);
			return;
		}
	}
}
export { harper };
const isEntry =
	process.argv[1] &&
	fs.existsSync(process.argv[1]) &&
	fs.realpathSync(process.argv[1]) === path.join(RUNTIME_SRC_ROOT, `bin/harper${RUNTIME_FILE_EXT}`);
if (isEntry) {
	harper()
		.then((message) => {
			if (message) {
				// console.log is the canonical terminal output for CLI results; logger.notify would
				// print the same message a second time (its Console transport is stdout in CLI mode),
				// so `harper help` and friends were emitted twice.
				console.log(message);
			}
			// Intentionally not calling `process.exit(0);` so if a CLI
			// command resulted in a long running process (aka `run`),
			// it continues to run.
		})
		.catch((error) => {
			if (error) console.error(formatCliError(error));
			process.exit(1);
		});
}
