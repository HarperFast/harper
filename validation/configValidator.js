'use strict';

const fs = require('fs-extra');
const Joi = require('joi');
const os = require('os');
const { boolean, string, number, array } = Joi.types();
const { totalmem } = require('os');
const path = require('path');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const certificates_terms = require('../utility/terms/certificates');
const hdb_terms = require('../utility/hdbTerms');
const validator = require('./validationWrapper');

const DEFAULT_LOG_FOLDER = 'log';
const DEFAULT_COMPONENTS_FOLDER = 'components';
const DEFAULT_CORES_IF_ERR = 4;
const INVALID_SIZE_UNIT_MSG = 'Invalid logging.rotation.maxSize unit. Available units are G, M or K';
const INVALID_INTERVAL_UNIT_MSG = 'Invalid logging.rotation.interval unit. Available units are D, H or M (minutes)';
const INVALID_MAX_SIZE_VALUE_MSG =
	"Invalid logging.rotation.maxSize value. Value should be a number followed by unit e.g. '10M'";
const INVALID_INTERVAL_VALUE_MSG =
	"Invalid logging.rotation.interval value. Value should be a number followed by unit e.g. '10D'";
const UNDEFINED_OPS_API = 'rootPath config parameter is undefined';
const UNDEFINED_NATS_ENABLED = 'clustering.enabled config parameter is undefined';

const port_constraints = Joi.alternatives([number.min(0), string])
	.optional()
	.empty(null);
const route_constraints = Joi.alternatives([
	array
		.items(
			string,
			{
				host: string.required(),
				port: port_constraints,
			},
			{
				hostname: string.required(),
				port: port_constraints,
			}
		)
		.empty(null),
	array.items(string),
]);

let hdb_root;
let skip_fs_val = false;

module.exports = {
	configValidator,
	routesValidator,
	route_constraints,
};

function configValidator(config_json, skip_fs_validation = false) {
	skip_fs_val = skip_fs_validation;
	hdb_root = config_json.rootPath;
	if (hdb_utils.isEmpty(hdb_root)) {
		throw UNDEFINED_OPS_API;
	}

	const enabled_constraints = boolean.optional();
	const threads_constraints = number.min(0).max(1000).empty(null).default(setDefaultThreads);
	const root_constraints = string
		.pattern(/^[\\\/]$|([\\\/a-zA-Z_0-9\:-]+)+$/, 'directory path')
		.empty(null)
		.default(setDefaultRoot);
	const pem_file_constraints = string.optional().empty(null);
	const nats_term_constraints = string
		.pattern(/^[^\s.,*>]+$/)
		.messages({ 'string.pattern.base': '{:#label} invalid, must not contain ., * or >' })
		.empty(null)
		.required();
	const clustering_stream_path_constraints = Joi.string().empty(null).default(setDefaultRoot);
	const storage_path_constraints = Joi.custom(validatePath).empty(null).default(setDefaultRoot);

	const clustering_enabled = config_json.clustering?.enabled;
	const tls_constraints = Joi.object({
		certificate: pem_file_constraints,
		certificateAuthority: pem_file_constraints,
		privateKey: pem_file_constraints,
	});

	// If clustering is enabled validate clustering config
	let clustering_validation_schema;
	if (clustering_enabled === true) {
		clustering_validation_schema = Joi.object({
			enabled: enabled_constraints,
			hubServer: Joi.object({
				cluster: Joi.object({
					name: Joi.required().empty(null),
					network: Joi.object({
						port: port_constraints,
						routes: route_constraints,
					}).required(),
				}).required(),
				leafNodes: Joi.object({
					network: Joi.object({
						port: port_constraints,
					}).required(),
				}).required(),
				network: Joi.object({
					port: port_constraints,
				}).required(),
			}).required(),
			leafServer: Joi.object({
				network: Joi.object({
					port: port_constraints,
					routes: route_constraints,
				}).required(),
				streams: Joi.object({
					// Max age must be above duplicate_window stream setting
					maxAge: number.min(120).allow(null).optional(),
					maxBytes: number.min(1).allow(null).optional(),
					maxMsgs: number.min(1).allow(null).optional(),
					path: clustering_stream_path_constraints,
				}).required(),
			}).required(),
			logLevel: Joi.valid('error', 'warn', 'info', 'debug', 'trace'),
			nodeName: nats_term_constraints,
			republishMessages: boolean.optional(),
			databaseLevel: boolean.optional(),
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: pem_file_constraints,
				privateKey: pem_file_constraints,
				insecure: boolean.required(),
				verify: boolean.optional(),
			}),
			user: string.optional().empty(null),
		}).optional();
	} else {
		clustering_validation_schema = Joi.object({
			enabled: enabled_constraints,
			// tls needs to be here to set defaults if clustering disabled
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: pem_file_constraints,
				privateKey: pem_file_constraints,
				insecure: boolean.optional(),
			}),
		}).optional();
	}

	const config_schema = Joi.object({
		authentication: Joi.alternatives(
			Joi.object({
				authorizeLocal: boolean,
				cacheTTL: number.required(),
				enableSessions: boolean,
        hashFunction: string.valid('md5', 'sha256', 'argon2id').optional().empty(null),
      }),
			boolean
		).optional(),
		analytics: Joi.object({
			aggregatePeriod: number,
		}),
		replication: Joi.object({
			hostname: Joi.alternatives(string, number).optional().empty(null),
			url: string.optional().empty(null),
			port: port_constraints,
			securePort: port_constraints,
			routes: array.optional().empty(null),
			databases: Joi.alternatives(string, array),
			enableRootCAs: boolean.optional(),
			copyTablesToCatchUp: boolean.optional(),
		}).optional(),
		componentsRoot: root_constraints.optional(),
		clustering: clustering_validation_schema,
		localStudio: Joi.object({
			enabled: enabled_constraints,
		}).required(),
		logging: Joi.object({
			auditAuthEvents: Joi.object({
				logFailed: boolean,
				logSuccessful: boolean,
			}),
			file: boolean.required(),
			level: Joi.valid('notify', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'),
			rotation: Joi.object({
				enabled: boolean.optional(),
				compress: boolean.optional(),
				interval: string.custom(validateRotationInterval).optional().empty(null),
				maxSize: string.custom(validateRotationMaxSize).optional().empty(null),
				path: string.optional().empty(null).default(setDefaultRoot),
			}).required(),
			root: root_constraints,
			stdStreams: boolean.required(),
			auditLog: boolean.required(),
		}).required(),
		operationsApi: Joi.object({
			network: Joi.object({
				cors: boolean.optional(),
				corsAccessList: array.optional(),
				headersTimeout: number.min(1).optional(),
				keepAliveTimeout: number.min(1).optional(),
				port: port_constraints,
				domainSocket: Joi.optional().empty('hdb/operations-server').default(setDefaultRoot),
				securePort: port_constraints,
				timeout: number.min(1).optional(),
			}).optional(),
			tls: Joi.alternatives([Joi.array().items(tls_constraints), tls_constraints]),
		}).required(),
		rootPath: string.pattern(/^[\\\/]$|([\\\/a-zA-Z_0-9\:-]+)+$/, 'directory path').required(),
		mqtt: Joi.object({
			network: Joi.object({
				port: port_constraints,
				securePort: port_constraints,
				mtls: Joi.alternatives([
					boolean.optional(),
					Joi.object({
						user: string.optional(),
						certificateAuthority: pem_file_constraints,
						required: boolean.optional(),
					}),
				]),
			}).required(),
			webSocket: boolean.optional(),
			requireAuthentication: boolean.optional(),
		}),
		http: Joi.object({
			compressionThreshold: number.optional(),
			cors: boolean.optional(),
			corsAccessList: array.optional(),
			headersTimeout: number.min(1).optional(),
			port: port_constraints,
			securePort: port_constraints,
			maxHeaderSize: number.optional(),
			mtls: Joi.alternatives([
				boolean.optional(),
				Joi.object({
					user: string.optional(),
					certificateAuthority: pem_file_constraints,
					required: boolean.optional(),
				}),
			]),
			threadRange: Joi.alternatives([array.optional(), string.optional()]),
		}).required(),
		threads: Joi.alternatives(
			threads_constraints.optional(),
			Joi.object({
				count: threads_constraints.optional(),
				debug: Joi.alternatives(
					boolean.optional(),
					Joi.object({
						startingPort: number.min(1).optional(),
						host: string.optional(),
						waitForDebugger: boolean.optional(),
					})
				),
				maxHeapMemory: number.min(0).optional(),
			})
		),
		storage: Joi.object({
			writeAsync: boolean.required(),
			overlappingSync: boolean.optional(),
			caching: boolean.optional(),
			compression: Joi.alternatives([
				boolean.optional(),
				Joi.object({ dictionary: string.optional(), threshold: number.optional() }),
			]),
			compactOnStart: boolean.optional(),
			compactOnStartKeepBackup: boolean.optional(),
			noReadAhead: boolean.optional(),
			path: storage_path_constraints,
			prefetchWrites: boolean.optional(),
			maxFreeSpaceToLoad: number.optional(),
			maxFreeSpaceToRetain: number.optional(),
		}).required(),
		ignoreScripts: boolean.optional(),
		tls: Joi.alternatives([Joi.array().items(tls_constraints), tls_constraints]),
	});

	// Not using the validation wrapper here because we need the result if validation is successful because
	// there is default values set as part of validation.
	return config_schema.validate(config_json, {
		allowUnknown: true,
		abortEarly: false,
		errors: { wrap: { label: "'" } },
	});
}

// This function is used to validate existence of paths passed as an argument
function doesPathExist(path_to_check) {
	if (skip_fs_val) return null;
	let exists = fs.existsSync(path_to_check);
	if (exists) {
		return null;
	}

	return `Specified path ${path_to_check} does not exist.`;
}

function validatePemFile(value, helpers) {
	if (value === null) return;

	const does_exist_msg = doesPathExist(value);
	if (does_exist_msg) {
		return helpers.message(does_exist_msg);
	}

	return value;
}

function validatePath(value, helpers) {
	Joi.assert(value, string.pattern(/^[\\\/]$|([\\\/a-zA-Z_0-9\:-]+)+$/, 'directory path'));

	const does_exist_msg = doesPathExist(value);
	if (does_exist_msg) {
		return helpers.message(does_exist_msg);
	}
}

function validateRotationMaxSize(value, helpers) {
	const unit = value.slice(-1);
	if (unit !== 'G' && unit !== 'M' && unit !== 'K') {
		return helpers.message(INVALID_SIZE_UNIT_MSG);
	}

	const size = value.slice(0, -1);
	if (isNaN(parseInt(size))) {
		return helpers.message(INVALID_MAX_SIZE_VALUE_MSG);
	}

	return value;
}

function validateRotationInterval(value, helpers) {
	const unit = value.slice(-1);
	if (unit !== 'D' && unit !== 'H' && unit !== 'M') {
		return helpers.message(INVALID_INTERVAL_UNIT_MSG);
	}

	const size = value.slice(0, -1);
	if (isNaN(parseInt(size))) {
		return helpers.message(INVALID_INTERVAL_VALUE_MSG);
	}

	return value;
}

function setDefaultThreads(parent, helpers) {
	const config_param = helpers.state.path.join('.');
	let processors = os.cpus().length;

	// default to one less than the number of logical CPU/processors so we can have good concurrency with the
	// ingest process and any extra processes (jobs, reply, etc.).
	let num_processes = processors - 1;
	// But if only two or less processors, keep two processes so we have some level of concurrency fairness
	if (num_processes <= 2) num_processes = 2;
	let available_memory = process.constrainedMemory?.() || totalmem(); // used constrained memory if it is available
	// and lower than total memory
	available_memory = Math.round(Math.min(available_memory, totalmem()) / 1000000);
	// (available memory -750MB) / 300MB
	num_processes = Math.max(Math.min(num_processes, Math.round((available_memory - 750) / 300)), 1);
	hdb_logger.info(
		`Detected ${processors} cores and ${available_memory}MB on this machine, defaulting ${config_param} to ${num_processes}`
	);
	return num_processes;
}

/**
 * Sets a default root for a config param.
 * @param parent
 * @param helpers
 * @returns {string}
 */
function setDefaultRoot(parent, helpers) {
	// For some reason Joi is still calling set default when value is not null.
	// For that reason we do this check.
	const config_param = helpers.state.path.join('.');
	if (!hdb_utils.isEmpty(helpers.original) && config_param !== 'operationsApi.network.domainSocket') {
		return helpers.original;
	}

	if (hdb_utils.isEmpty(hdb_root)) {
		throw new Error(`Error setting default root for: ${config_param}. HDB root is not defined`);
	}

	switch (config_param) {
		case 'componentsRoot':
			return path.join(hdb_root, DEFAULT_COMPONENTS_FOLDER);
		case 'logging.root':
			return path.join(hdb_root, DEFAULT_LOG_FOLDER);
		case 'clustering.leafServer.streams.path':
			return path.join(hdb_root, 'clustering', 'leaf');
		case 'storage.path':
			const legacy_storage_path = path.join(hdb_root, hdb_terms.LEGACY_DATABASES_DIR_NAME);
			if (fs.existsSync(legacy_storage_path)) return legacy_storage_path;
			return path.join(hdb_root, hdb_terms.DATABASES_DIR_NAME);
		case 'logging.rotation.path':
			return path.join(hdb_root, DEFAULT_LOG_FOLDER);
		case 'operationsApi.network.domainSocket':
			return config_param == null ? null : path.join(hdb_root, 'operations-server');
		default:
			throw new Error(
				`Error setting default root for config parameter: ${config_param}. Unrecognized config parameter`
			);
	}
}

/**
 * Validates just the routes array.
 * @param routes_array
 * @returns {*}
 */
function routesValidator(routes_array) {
	const schema = Joi.object({
		routes: route_constraints,
	});
	return validator.validateBySchema({ routes: routes_array }, schema);
}
