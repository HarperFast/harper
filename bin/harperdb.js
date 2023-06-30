#!/usr/bin/env node
'use strict';

const logger = require('../utility/logging/harper_logger');
const version = require('./version');
const hdb_terms = require('../utility/hdbTerms');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const check_node = require('../launchServiceScripts/utility/checkNodeVersion');
const env = require('../utility/environment/environmentManager');
const socket_router = require('../server/threads/socketRouter');
const { SERVICE_ACTIONS_ENUM } = hdb_terms;

harperDBService();

function harperDBService() {
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

	fs.readdir(path.join(PACKAGE_ROOT, 'bin'), (err) => {
		if (err) {
			return logger.error(err);
		}

		if (process.argv && process.argv[2] && !process.argv[2].startsWith('-')) {
			service = process.argv[2].toLowerCase();
		}

		let result = undefined;
		switch (service) {
			case SERVICE_ACTIONS_ENUM.DEBUG:
				require('inspector').open(9229);
				socket_router.debugMode = true;
			// fall through
			case SERVICE_ACTIONS_ENUM.RUN:
				// Run a specific application folder
				let app_folder = process.argv[3];
				if (app_folder && app_folder[0] !== '-') process.env.RUN_HDB_APP = app_folder;
				require('./run').main();
				break;
			case SERVICE_ACTIONS_ENUM.START:
				// The require is here to better control the flow of imports when this module is called.
				const run = require('./run');
				result = run.launch();
				break;
			case SERVICE_ACTIONS_ENUM.INSTALL:
				const install = require('./install');
				install()
					.then(() => {
						// The require is here to better control the flow of imports when this module is called.
						return require('./run').main(true);
					})
					.catch((install_err) => {
						console.error(install_err);
					});
				break;
			case SERVICE_ACTIONS_ENUM.REGISTER:
				// register requires a lot of imports that could fail during install, so only bring it in when needed.
				const register = require('./register');
				register
					.register()
					.then((response) => {
						console.log(response);
					})
					.catch((register_err) => {
						console.error(register_err);
					});
				break;
			case SERVICE_ACTIONS_ENUM.STOP:
				// The require is here to better control the flow of imports when this module is called.
				const stop = require('./stop');
				stop()
					.then(() => {
						process.exit(0);
					})
					.catch((stop_err) => {
						console.error(stop_err);
					});
				break;
			case SERVICE_ACTIONS_ENUM.RESTART:
				// The require is here to better control the flow of imports when this module is called.
				const restart = require('./restart');
				restart
					.restart({})
					.then()
					.catch((restart_err) => {
						logger.error(restart_err);
						console.error(`There was an error restarting harperdb. ${restart_err}`);
						process.exit(1);
					});
				break;
			case SERVICE_ACTIONS_ENUM.VERSION:
				version.printVersion();
				break;
			case SERVICE_ACTIONS_ENUM.UPGRADE:
				logger.setLogLevel(hdb_terms.LOG_LEVELS.INFO);
				// The require is here to better control the flow of imports when this module is called.
				const upgrade = require('./upgrade');
				upgrade
					.upgrade(null)
					.then(() => {
						// all done, no-op
						console.log(`Your instance of HDB is up to date!`);
					})
					.catch((e) => {
						logger.error(`Got an error during upgrade ${e}`);
					});
				break;
			case SERVICE_ACTIONS_ENUM.STATUS:
				const status = require('./status');
				status()
					.then()
					.catch((err) => {
						console.error(err);
					});
				break;
			case undefined:
				// The require is here to better control the flow of imports when this module is called.
				require('./run').main();
				break;
			default:
				console.warn(`The "${service}" command is not understood.`);
			// fall through
			case SERVICE_ACTIONS_ENUM.HELP:
				console.log(`
Usage: harperdb [command]

With no command, harperdb will simply run HarperDB (in the foreground) 

Commands:
  run <path> - Run the application in the specified path
  debug <path> - Debug the application in the specified path
  version - Print the version
  start - Starts a separate background process for harperdb and CLI will exit
  stop - Stop the harperdb background process
  restart - Restart the harperdb background process
  install - Install harperdb
  register - Register harperdb
  upgrade - Upgrade harperdb
  status - Print the status of HarperDB and clustering`);
		}
	});
}
