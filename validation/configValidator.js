'use strict';

const fs = require('fs-extra');
const Joi = require('joi');
const os = require('os');
const { boolean, string, number, array } = Joi.types();
const { totalmem } = require('os');
const path = require('path');
const hdbLogger = require('../utility/logging/harper_logger.js');
const hdbUtils = require('../utility/common_utils.js');
const certificatesTerms = require('../utility/terms/certificates.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const validator = require('./validationWrapper.js');

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

const portConstraints = Joi.alternatives([number.min(0), string])
	.optional()
	.empty(null);
const routeConstraints = Joi.alternatives([
	array
		.items(
			string,
			{
				host: string.required(),
				port: portConstraints,
			},
			{
				hostname: string.required(),
				port: portConstraints,
			}
		)
		.empty(null),
	array.items(string),
]);

let hdbRoot;
let skipFsVal = false;

module.exports = {
	configValidator,
	routesValidator,
	routeConstraints,
};

function configValidator(configJson, skipFsValidation = false) {
	skipFsVal = skipFsValidation;
	hdbRoot = configJson.rootPath;
	if (hdbUtils.isEmpty(hdbRoot)) {
		throw UNDEFINED_OPS_API;
	}

	const enabledConstraints = boolean.optional();
	const threadsConstraints = number.min(0).max(1000).empty(null).default(setDefaultThreads);
	const rootConstraints = string
		.pattern(/^[\\\/]$|([\\\/a-zA-Z_0-9\:-]+)+$/, 'directory path')
		.empty(null)
		.default(setDefaultRoot);
	const pemFileConstraints = string.optional().empty(null);
	const natsTermConstraints = string
		.pattern(/^[^\s.,*>]+$/)
		.messages({ 'string.pattern.base': '{:#label} invalid, must not contain ., * or >' })
		.empty(null)
		.required();
	const clusteringStreamPathConstraints = Joi.string().empty(null).default(setDefaultRoot);
	const storagePathConstraints = Joi.custom(validatePath).empty(null).default(setDefaultRoot);

	const clusteringEnabled = configJson.clustering?.enabled;
	const tlsConstraints = Joi.object({
		certificate: pemFileConstraints,
		certificateAuthority: pemFileConstraints,
		privateKey: pemFileConstraints,
	});

	// If clustering is enabled validate clustering config
	let clusteringValidationSchema;
	if (clusteringEnabled === true) {
		clusteringValidationSchema = Joi.object({
			enabled: enabledConstraints,
			hubServer: Joi.object({
				cluster: Joi.object({
					name: Joi.required().empty(null),
					network: Joi.object({
						port: portConstraints,
						routes: routeConstraints,
					}).required(),
				}).required(),
				leafNodes: Joi.object({
					network: Joi.object({
						port: portConstraints,
					}).required(),
				}).required(),
				network: Joi.object({
					port: portConstraints,
				}).required(),
			}).required(),
			leafServer: Joi.object({
				network: Joi.object({
					port: portConstraints,
					routes: routeConstraints,
				}).required(),
				streams: Joi.object({
					// Max age must be above duplicateWindow stream setting
					maxAge: number.min(120).allow(null).optional(),
					maxBytes: number.min(1).allow(null).optional(),
					maxMsgs: number.min(1).allow(null).optional(),
					path: clusteringStreamPathConstraints,
				}).required(),
			}).required(),
			logLevel: Joi.valid('error', 'warn', 'info', 'debug', 'trace'),
			nodeName: natsTermConstraints,
			republishMessages: boolean.optional(),
			databaseLevel: boolean.optional(),
			tls: Joi.object({
				certificate: pemFileConstraints,
				certificateAuthority: pemFileConstraints,
				privateKey: pemFileConstraints,
				insecure: boolean.required(),
				verify: boolean.optional(),
			}),
			user: string.optional().empty(null),
		}).optional();
	} else {
		clusteringValidationSchema = Joi.object({
			enabled: enabledConstraints,
			// tls needs to be here to set defaults if clustering disabled
			tls: Joi.object({
				certificate: pemFileConstraints,
				certificateAuthority: pemFileConstraints,
				privateKey: pemFileConstraints,
				insecure: boolean.optional(),
			}),
		}).optional();
	}

	const configSchema = Joi.object({
		authentication: Joi.alternatives(
			Joi.object({
				authorizeLocal: boolean,
				cacheTTL: number.required(),
				cookie: Joi.object({
					domains: array.items(string).optional(),
					expires: string.optional(),
				}),
				enableSessions: boolean,
				hashFunction: string.valid('md5', 'sha256', 'argon2id').optional().empty(null),
			}),
			boolean
		).optional(),
		analytics: Joi.object({
			aggregatePeriod: number,
			replicate: boolean.optional(),
		}),
		replication: Joi.object({
			hostname: Joi.alternatives(string, number).optional().empty(null),
			url: string.optional().empty(null),
			port: portConstraints,
			securePort: portConstraints,
			routes: array.optional().empty(null),
			databases: Joi.alternatives(string, array),
			enableRootCAs: boolean.optional(),
			copyTablesToCatchUp: boolean.optional(),
		}).optional(),
		componentsRoot: rootConstraints.optional(),
		clustering: clusteringValidationSchema,
		localStudio: Joi.object({
			enabled: enabledConstraints,
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
			root: rootConstraints,
			stdStreams: boolean.required(),
			auditLog: boolean.required(),
		}).required(),
		operationsApi: Joi.object({
			network: Joi.object({
				cors: boolean.optional(),
				corsAccessList: array.optional(),
				headersTimeout: number.min(1).optional(),
				keepAliveTimeout: number.min(1).optional(),
				port: portConstraints,
				domainSocket: Joi.optional().empty('hdb/operations-server').default(setDefaultRoot),
				securePort: portConstraints,
				timeout: number.min(1).optional(),
			}).optional(),
			tls: Joi.alternatives([Joi.array().items(tlsConstraints), tlsConstraints]),
		}).required(),
		rootPath: string.pattern(/^[\\\/]$|([\\\/a-zA-Z_0-9\:-]+)+$/, 'directory path').required(),
		mqtt: Joi.object({
			network: Joi.object({
				port: portConstraints,
				securePort: portConstraints,
				mtls: Joi.alternatives([
					boolean.optional(),
					Joi.object({
						user: string.optional(),
						certificateAuthority: pemFileConstraints,
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
			port: portConstraints,
			securePort: portConstraints,
			maxHeaderSize: number.optional(),
			mtls: Joi.alternatives([
				boolean.optional(),
				Joi.object({
					user: string.optional(),
					certificateAuthority: pemFileConstraints,
					required: boolean.optional(),
				}),
			]),
			threadRange: Joi.alternatives([array.optional(), string.optional()]),
		}).required(),
		threads: Joi.alternatives(
			threadsConstraints.optional(),
			Joi.object({
				count: threadsConstraints.optional(),
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
			path: storagePathConstraints,
			prefetchWrites: boolean.optional(),
			maxFreeSpaceToLoad: number.optional(),
			maxFreeSpaceToRetain: number.optional(),
		}).required(),
		ignoreScripts: boolean.optional(),
		tls: Joi.alternatives([Joi.array().items(tlsConstraints), tlsConstraints]),
	});

	// Not using the validation wrapper here because we need the result if validation is successful because
	// there is default values set as part of validation.
	return configSchema.validate(configJson, {
		allowUnknown: true,
		abortEarly: false,
		errors: { wrap: { label: "'" } },
	});
}

// This function is used to validate existence of paths passed as an argument
function doesPathExist(pathToCheck) {
	if (skipFsVal) return null;
	let exists = fs.existsSync(pathToCheck);
	if (exists) {
		return null;
	}

	return `Specified path ${pathToCheck} does not exist.`;
}

function validatePemFile(value, helpers) {
	if (value === null) return;

	const doesExistMsg = doesPathExist(value);
	if (doesExistMsg) {
		return helpers.message(doesExistMsg);
	}

	return value;
}

function validatePath(value, helpers) {
	Joi.assert(value, string.pattern(/^[\\\/]$|([\\\/a-zA-Z_0-9\:-]+)+$/, 'directory path'));

	const doesExistMsg = doesPathExist(value);
	if (doesExistMsg) {
		return helpers.message(doesExistMsg);
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
	const configParam = helpers.state.path.join('.');
	let processors = os.cpus().length;

	// default to one less than the number of logical CPU/processors so we can have good concurrency with the
	// ingest process and any extra processes (jobs, reply, etc.).
	let numProcesses = processors - 1;
	// But if only two or less processors, keep two processes so we have some level of concurrency fairness
	if (numProcesses <= 2) numProcesses = 2;
	let availableMemory = process.constrainedMemory?.() || totalmem(); // used constrained memory if it is available
	// and lower than total memory
	availableMemory = Math.round(Math.min(availableMemory, totalmem()) / 1000000);
	// (available memory -750MB) / 300MB
	numProcesses = Math.max(Math.min(numProcesses, Math.round((availableMemory - 750) / 300)), 1);
	hdbLogger.info(
		`Detected ${processors} cores and ${availableMemory}MB on this machine, defaulting ${configParam} to ${numProcesses}`
	);
	return numProcesses;
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
	const configParam = helpers.state.path.join('.');
	if (!hdbUtils.isEmpty(helpers.original) && configParam !== 'operationsApi.network.domainSocket') {
		return helpers.original;
	}

	if (hdbUtils.isEmpty(hdbRoot)) {
		throw new Error(`Error setting default root for: ${configParam}. HDB root is not defined`);
	}

	switch (configParam) {
		case 'componentsRoot':
			return path.join(hdbRoot, DEFAULT_COMPONENTS_FOLDER);
		case 'logging.root':
			return path.join(hdbRoot, DEFAULT_LOG_FOLDER);
		case 'clustering.leafServer.streams.path':
			return path.join(hdbRoot, 'clustering', 'leaf');
		case 'storage.path':
			const legacyStoragePath = path.join(hdbRoot, hdbTerms.LEGACY_DATABASES_DIR_NAME);
			if (fs.existsSync(legacyStoragePath)) return legacyStoragePath;
			return path.join(hdbRoot, hdbTerms.DATABASES_DIR_NAME);
		case 'logging.rotation.path':
			return path.join(hdbRoot, DEFAULT_LOG_FOLDER);
		case 'operationsApi.network.domainSocket':
			return configParam == null ? null : path.join(hdbRoot, 'operations-server');
		default:
			throw new Error(
				`Error setting default root for config parameter: ${configParam}. Unrecognized config parameter`
			);
	}
}

/**
 * Validates just the routes array.
 * @param routesArray
 * @returns {*}
 */
function routesValidator(routesArray) {
	const schema = Joi.object({
		routes: routeConstraints,
	});
	return validator.validateBySchema({ routes: routesArray }, schema);
}
