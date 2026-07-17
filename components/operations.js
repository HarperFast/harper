'use strict';

const path = require('node:path');
const { isMainThread } = require('node:worker_threads');
const fs = require('fs-extra');
const fg = require('fast-glob');
const normalize = require('normalize-path');
const validator = require('./operationsValidation.js');
const log = require('../utility/logging/harper_logger.ts');
const hdbTerms = require('../utility/hdbTerms.ts');
const env = require('../utility/environment/environmentManager.ts');
const configUtils = require('../config/configUtils.ts');
const hdbUtils = require('../utility/common_utils.ts');
const {
	isEnvFile,
	isProtectedEnvFile,
	parseEnvKeys,
	renderMaskedEnv,
	upsertEnvValues,
	removeEnvKeys,
} = require('../utility/envFile.ts');
const { handleHDBError, ServerError, hdbErrors } = require('../utility/errors/hdbError.ts');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const manageThreads = require('../server/threads/manageThreads.js');
const { packageDirectory } = require('../components/packageComponent.ts');
const { Resources } = require('../resources/Resources.ts');
const { Application, prepareApplication, ASIDE_STAGING_DIR } = require('./Application.ts');
const { server } = require('../server/Server.ts');
const { DeploymentRecorder, awaitDeploymentRow, DEFAULT_AWAIT_ROW_TIMEOUT_MS } = require('./deploymentRecorder.ts');
const { ProgressEmitter } = require('../server/serverHelpers/progressEmitter.ts');

/**
 * Read the settings.js file and return the
 *
 * @return Object.<String>
 */
function customFunctionsStatus() {
	log.trace(`getting custom api status`);
	let response = {};

	try {
		response = {
			port: env.get(hdbTerms.CONFIG_PARAMS.HTTP_PORT),
			directory: configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT),
			is_enabled: true,
		};
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.FUNCTION_STATUS,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
	return response;
}

/**
 * Read the user-defined custom_functions/routes directory and return the file names
 *
 * @return Array.<String>
 */
function getCustomFunctions() {
	log.trace(`getting custom api endpoints`);
	let response = {};
	const dir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);

	try {
		const projectFolders = fg.sync(normalize(`${dir}/*`), { onlyDirectories: true });

		projectFolders.forEach((projectFolder) => {
			const folderName = projectFolder.split('/').pop();
			response[folderName] = {
				routes: fg
					.sync(normalize(`${projectFolder}/routes/*.js`))
					.map((filepath) => filepath.split('/').pop().split('.js')[0]),
				helpers: fg
					.sync(normalize(`${projectFolder}/helpers/*.js`))
					.map((filepath) => filepath.split('/').pop().split('.js')[0]),
			};
		});
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.GET_FUNCTIONS,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
	return response;
}

/**
 * Read the specified functionName file in the custom_functions/routes directory and return the file content
 *
 * @param {NodeObject} req
 * @returns {string}
 */
function getCustomFunction(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	if (req.file) {
		req.file = path.parse(req.file).name;
	}

	const validation = validator.getDropCustomFunctionValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`getting custom api endpoint file content`);
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file } = req;
	const fileLocation = path.join(cfDir, project, type, file + '.js');

	try {
		return fs.readFileSync(fileLocation, { encoding: 'utf8' });
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.GET_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Write the supplied function_content to the provided functionName file in the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {{message:string}}
 */
async function setCustomFunction(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	if (req.file) {
		req.file = path.parse(req.file).name;
	}

	const validation = validator.setCustomFunctionValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`setting custom function file content`);
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file, function_content } = req;

	try {
		fs.outputFileSync(path.join(cfDir, project, type, file + '.js'), function_content);
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully updated custom function: ${file}.js`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SET_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Delete the provided functionName file from the custom_functions/routes directory
 *
 * @param {NodeObject} req
 * @returns {{message:string}}
 */
async function dropCustomFunction(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	if (req.file) {
		req.file = path.parse(req.file).name;
	}

	const validation = validator.getDropCustomFunctionValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`dropping custom function file`);
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, type, file } = req;

	try {
		fs.unlinkSync(path.join(cfDir, project, type, file + '.js'));
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully deleted custom function: ${file}.js`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.DROP_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Create a new project folder in the components folder and copy the template into it
 * @param {NodeObject} req
 * @returns {{message:string}}
 */
async function addComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.addComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`adding component`);
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project, install_command, install_timeout, install_allow_scripts } = req;

	const template = req.template || 'https://github.com/harperdb/application-template';

	try {
		const projectDir = path.join(cfDir, project);
		fs.mkdirSync(projectDir, { recursive: true });
		const application = new Application({
			name: project,
			packageIdentifier: template,
			install: {
				command: install_command,
				timeout: install_timeout,
				allowInstallScripts: install_allow_scripts,
			},
		});
		await prepareApplication(application);
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully added project: ${project}`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ADD_FUNCTION,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Remove a project folder from the custom_functions folder
 *
 * @param {NodeObject} req
 * @returns {string}
 */
async function dropCustomFunctionProject(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.dropCustomFunctionProjectValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	log.trace(`dropping custom function project`);
	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project } = req;

	let apps = env.get(hdbTerms.CONFIG_PARAMS.APPS);
	if (!hdbUtils.isEmptyOrZeroLength(apps)) {
		let appFound = false;
		for (const [i, app] of apps.entries()) {
			if (app.name === project) {
				apps.splice(i, 1);
				appFound = true;
				break;
			}
		}

		if (appFound) {
			configUtils.updateConfigValue(hdbTerms.CONFIG_PARAMS.APPS, apps);

			return `Successfully deleted project: ${project}`;
		}
	}

	try {
		const projectDir = path.join(cfDir, project);
		fs.rmSync(projectDir, { recursive: true });
		let response = await server.replication.replicateOperation(req);
		response.message = `Successfully deleted project: ${project}`;
		return response;
	} catch (err) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.DROP_FUNCTION_PROJECT,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
			log.ERR,
			err
		);
	}
}

/**
 * Will package a component into a temp tar file then output that file as a base64 string.
 * Req can accept a skip_node_modules boolean which will skip the node mods when creating temp tar file.
 * @param req
 * @returns {Promise<{payload: *, project}>}
 */
async function packageComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	}

	const validation = validator.packageComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const { project } = req;
	log.trace(`packaging component`, project);

	let pathToProject;
	try {
		pathToProject = await fs.realpath(path.join(cfDir, project));
	} catch (err) {
		if (err.code !== hdbTerms.NODE_ERROR_CODES.ENOENT) throw err;
		try {
			pathToProject = await fs.realpath(path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project));
		} catch (err) {
			if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) throw new Error(`Unable to locate project '${project}'`);
		}
	}

	const payload = (await packageDirectory(pathToProject, req)).toString('base64');

	// return the package payload as base64-encoded string
	return { project, payload };
}

/**
 * Can deploy a component in multiple ways. If a 'package' is provided all it will do is write that package to
 * harperdb-config, when HDB is restarted the package will be installed in hdb/nodeModules. If a base64 encoded string is passed it
 * will write string to a temp tar file and extract that file into the deployed project in hdb/components.
 * @param req
 * @returns {Promise<string>}
 */
async function deployComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	} else if (req.package) {
		req.project = getProjectNameFromPackage(req.package);
	}

	const validation = validator.deployComponentValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	// Ingest any provided credential token into the secrets store so the credential lives as
	// replicated ciphertext (reference, not embed); already-reference entries pass through, and with
	// no custody a literal token stays as a transient, this-node-only fallback (#1158). Peers
	// re-running a replicated deploy already carry references and never re-ingest.
	const { ingestCredentials, resolveCredentials } = require('./secretOperations.ts');
	req.credentials = await ingestCredentials(req, req.credentials, req.project);
	// References are safe to persist (config + deployment row) and replicate; a no-custody literal
	// token is not — it is used only for this node's install below, then stripped before replication.
	const credentialReferences = (req.credentials ?? []).filter((entry) => entry && entry.secret !== undefined);

	// Write to root config if the request contains a package identifier
	if (req.package) {
		// Check if trying to overwrite a core component (requires force)
		// Lazy-load to avoid circular dependency with componentLoader
		const { TRUSTED_RESOURCE_PLUGINS } = require('./componentLoader.ts');
		if (TRUSTED_RESOURCE_PLUGINS[req.project] && !req.force) {
			throw handleHDBError(
				new Error(),
				`Cannot deploy component with name '${req.project}': this is a protected core component name. Use force: true to overwrite.`,
				HTTP_STATUS_CODES.CONFLICT
			);
		}

		const applicationConfig = { package: req.package };
		// Avoid writing an empty `install:` block
		if (req.install_command || req.install_timeout || req.install_allow_scripts !== undefined) {
			applicationConfig.install = {
				command: req.install_command,
				timeout: req.install_timeout,
				allowInstallScripts: req.install_allow_scripts,
			};
		}
		if (req.urlPath !== undefined) applicationConfig.urlPath = req.urlPath;
		// Persist credential references (never tokens) so every cold install of this component —
		// reboot, new peer, rollback — re-resolves the credential from the store.
		if (credentialReferences.length) applicationConfig.credentials = credentialReferences;
		await configUtils.addConfig(req.project, applicationConfig);
	}

	// Create a hdb_deployment row up front so the deploy is observable and auditable
	// even if the CLI disconnects. The row also holds the payload in a Blob attribute,
	// which doubles as the source for peer replication and (later) rollback.
	//
	// Only the origin node records — peers receiving a replicated deploy_component skip
	// recording so we don't accumulate one row per node for the same deploy. The row
	// reaches peers via the table's standard replication; the peer-side branch below
	// reads payload_blob back from there.
	const isReplicatedExecution = typeof req._deploymentId === 'string';
	// An SSE-bound caller already attached a ProgressEmitter (created in the server
	// handler so it can also drive the response stream). Reuse it; otherwise spin up a
	// fresh emitter so the recorder still gets phase events for non-SSE deploys.
	const emitter = isReplicatedExecution ? null : (req.progress ?? new ProgressEmitter());
	if (emitter && !req.progress) req.progress = emitter;
	const recorder = isReplicatedExecution
		? null
		: await DeploymentRecorder.create({
				project: req.project,
				package_identifier: req.package ?? null,
				user: req.hdb_user?.username,
				restart_mode: req.restart === 'rolling' ? 'rolling' : req.restart ? 'immediate' : null,
				// Reference form only — the rollback source for re-resolving the credential.
				credentials: credentialReferences.length ? credentialReferences : null,
				emitter,
			});
	if (recorder) req._deploymentId = recorder.deploymentId;

	const emit = (event, data) => emitter?.emit(event, data);

	// The new payload-via-replicated-row path depends on the `system` database actually
	// being replicated on this node. If the cluster is configured with a narrower
	// REPLICATION_DATABASES list that excludes `system`, peers won't see the
	// hdb_deployment row and falling back to sending req.payload through the operation
	// body is the only viable path.
	const systemReplicated = isSystemDatabaseReplicated();

	let extractionPayload = req.payload;
	// Bounded ring buffer of install stdout/stderr so a non-SSE caller sees the tail
	// in the thrown error. SSE callers still stream every line live.
	const installCapture = createInstallCapture();
	try {
		// On the origin, tee the tarball (Buffer or Readable from the multipart parser)
		// through a hash-and-size tap into the row's payload_blob, then re-source extraction
		// from the persisted blob. When `system` replicates, the blob becomes the channel
		// peers read from; when it doesn't, the blob stays local for audit and rollback.
		if (recorder && req.payload != null) {
			await recorder.ingestPayload(req.payload);
			extractionPayload = recorder.row.payload_blob.stream();
		} else if (isReplicatedExecution && req.payload == null && !req.package) {
			// Peer received a replicated deploy without a payload — read the tarball from
			// the replicated hdb_deployment row's payload_blob. Blob.stream() blocks on
			// in-flight BLOB_CHUNK writes until the chunks land. If the row never arrives
			// within the timeout, peer records a failure and origin sees it in peer_results.
			// The wait budget defaults to 120s but is overridable per-deploy via
			// `deployment_timeout` (ms) for clusters where the system-table channel is
			// heavily backlogged (harper-pro#402).
			const row = await awaitDeploymentRow(req._deploymentId, { timeoutMs: req.deployment_timeout });
			extractionPayload = row.payload_blob.stream();
		}

		// Resolve credential references into concrete tokens for this node's npm pack/install
		// (a no-custody literal-token fallback passes through unchanged). On a peer running a
		// replicated deploy, the referenced hdb_secret row may arrive just behind the deploy op, so
		// allow a bounded grace period (same budget as the payload-row wait) for it to replicate in.
		let credentialsWaitMs = 0;
		if (isReplicatedExecution) {
			const requested = Number(req.deployment_timeout);
			credentialsWaitMs = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_AWAIT_ROW_TIMEOUT_MS;
		}
		const resolvedCredentials = await resolveCredentials(req.credentials, req.project, {
			waitMs: credentialsWaitMs,
		});

		const application = new Application({
			name: req.project,
			payload: extractionPayload,
			packageIdentifier: req.package,
			install: {
				command: req.install_command,
				timeout: req.install_timeout,
				allowInstallScripts: req.install_allow_scripts,
			},
			// Tee each install line into both the capture buffer (for the thrown-error
			// fallback) and the SSE channel (when a caller is streaming). Peers have no
			// emitter, so their install output goes to the local logger and the buffer only.
			onInstallLine: (manager, stream, line) => {
				installCapture.push(manager, stream, line);
				if (emitter) emit('install', { manager, stream, line });
			},
			// Deploy credentials (already resolved above), used here for this node's npm pack/install:
			// registry entries via a transient .npmrc, git-host entries via the in-memory credential
			// socket the clone spawn talks to.
			credentials: resolvedCredentials,
		});
		// Reduce req.credentials to references only (never a token) before it can reach an error/log
		// path or replication: references are what peers resolve from their own replicated hdb_secret
		// copy; a no-custody literal token is dropped entirely (peers fall back to their fabric-injected
		// NPM_CONFIG_USERCONFIG, as before). This also fixes the prior success-only strip that leaked a
		// literal token on a prepare/load failure.
		if (credentialReferences.length) req.credentials = credentialReferences;
		else delete req.credentials;

		emit('phase', { phase: 'prepare', status: 'start' });
		await prepareApplication(application);
		emit('phase', { phase: 'prepare', status: 'done' });

		// now we attempt to actually load the component in case there is
		// an error we can immediately detect and report, but app code should not run on the main thread
		if (!isMainThread && !process.env.HARPER_SAFE_MODE) {
			const pseudoResources = new Resources();
			pseudoResources.isWorker = true;

			const componentLoader = require('./componentLoader.ts').default || require('./componentLoader.ts');
			const { trackScopeClose } = require('./scopeShutdown.ts');
			let lastError;
			componentLoader.setErrorReporter((error) => (lastError = error));
			emit('phase', { phase: 'load', status: 'start' });
			// This load exists only to surface load-time errors early; the Scopes it creates are
			// throwaway. They are collected (instead of registered for worker-shutdown auto-close) so we
			// can close them here once validation completes — otherwise each deploy leaks the Scope's
			// deploy-lifecycle listeners on this worker, eventually tripping MaxListenersExceededWarning
			// (#1462).
			const validationScopes = new Set();
			const validation = (async () => {
				try {
					await componentLoader.loadComponent(application.dirPath, pseudoResources, undefined, {
						collectScopes: validationScopes,
					});
				} finally {
					const closeResults = await Promise.allSettled(Array.from(validationScopes, (scope) => scope.close()));
					for (const result of closeResults) {
						if (result.status === 'rejected') log.warn('Failed to close a deploy-validation Scope', result.reason);
					}
				}
			})();
			// Track the load+close so a concurrent worker shutdown waits for these scopes to finish
			// disposing — a plugin may start a native runtime in handleApplication — before realExit.
			trackScopeClose(validation);
			await validation;
			emit('phase', { phase: 'load', status: 'done' });

			if (lastError) throw lastError;
		}
		const rollingRestart = req.restart === 'rolling';
		// if doing a rolling restart set restart to false so that other nodes don't also restart.
		req.restart = rollingRestart ? false : req.restart;
		// ProgressEmitter holds function listeners that can't survive the replication
		// channel's serialization; strip it unconditionally.
		delete req.progress;
		// req.credentials was already deleted immediately after the Application ctor (above) so the
		// token never reaches the replication channel or a peer's operation log; peers authenticate
		// against the private registry via their own fabric-injected NPM_CONFIG_USERCONFIG on reinstall.
		if (systemReplicated && recorder) {
			// The hdb_deployment row + payload_blob will reach peers via table replication,
			// so peers can look up the payload by deployment_id. Drop req.payload to keep
			// the operation body small (the operations channel has frame-size limits the
			// blob-replication channel doesn't share). _deploymentId is the handoff that
			// lets peers find the replicated row.
			delete req.payload;
		}
		// As each peer settles, update the origin row so observers polling get_deployment
		// see per-peer progress in real time rather than only at the aggregate end.
		// replicateOperation in harper-pro accepts an optional onPeerResult callback that
		// fires per peer; callers without the callback (older replicator) fall back to
		// the aggregate response.replicated below.
		const onPeerResult = recorder
			? (result) => {
					recorder.recordPeer(result);
					emit('peer', result);
				}
			: undefined;
		// Seal the recorder before the replicate phase so the row's terminal write (finish())
		// isn't part of the tight put burst that can commit out of order on a peer and revert
		// it (harperdb/harper#1170). onPeerResult/peer_results accumulate in memory and land in
		// finish()'s single write; live SSE 'peer' events still fire below.
		recorder?.seal();
		emit('phase', { phase: 'replicate', status: 'start' });
		let response = await server.replication.replicateOperation(req, { onPeerResult });
		emit('phase', { phase: 'replicate', status: 'done' });
		if (recorder && response?.replicated) {
			// Fallback path for replicators that don't honor onPeerResult: re-record the
			// aggregate. recordPeer's upsert-by-node-name semantics make this idempotent
			// when the per-peer callback already fired for these.
			recorder.recordPeers(response.replicated);
		}
		if (req.restart === true) {
			emit('phase', { phase: 'restart', status: 'start' });
			manageThreads.restartWorkers('http');
			emit('phase', { phase: 'restart', status: 'done' });
			response.message = `Successfully deployed: ${application.name}, restarting Harper`;
		} else if (rollingRestart) {
			const serverUtilities = require('../server/serverHelpers/serverUtilities.ts');
			emit('phase', { phase: 'restart', status: 'start' });
			const jobResponse = await serverUtilities.executeJob({
				operation: 'restart_service',
				service: 'http',
				replicated: true,
			});
			emit('phase', { phase: 'restart', status: 'done' });

			response.restartJobId = jobResponse.job_id;
			response.message = `Successfully deployed: ${application.name}, restarting Harper`;
		} else response.message = `Successfully deployed: ${application.name}`;

		// Replication failures don't reject replicateOperation — they surface as 'failed'
		// entries in peer_results. By default, treat any failed peer as an overall deploy
		// failure so the operation returns a non-2xx status (and the CLI a non-zero exit
		// code). The component is already deployed — and, if requested, restarted — on this
		// origin node; the failure signals that one or more peers did not receive it. Pass
		// ignore_replication_errors: true for best-effort deploys to partially-available clusters.
		if (recorder && !req.ignore_replication_errors) {
			const failedPeers = recorder.getFailedPeers();
			if (failedPeers.length > 0) {
				const detail = failedPeers
					.map((peer) => `${peer.node ?? 'unknown'} (${peer.error?.message ?? 'unknown error'})`)
					.join(', ');
				throw new ServerError(
					`Component '${application.name}' was deployed on the origin node but failed to replicate to ` +
						`${failedPeers.length} of ${recorder.row.peer_results.length} peer node(s): ${detail}. ` +
						`See deployment ${recorder.deploymentId} (get_deployment) for details, or pass ` +
						`ignore_replication_errors: true to treat replication failures as non-fatal.`
				);
			}
		}

		if (recorder) {
			response.deployment_id = recorder.deploymentId;
			// Reclaim the payload tarball for large deploys: every peer has now installed from
			// the blob (replicateOperation resolved) and the origin no longer needs it. Dropping
			// the reference before finish() folds the null into the single terminal write, which
			// unlinks the file locally and replicates the null so peers drop their copies too.
			// Metadata (size, hash, event_log) is retained for the audit trail. Two guards keep
			// the tarball when it's still the artifact you'd debug or retry with: failed deploys
			// don't reach this branch, and a deploy that reached here only because
			// ignore_replication_errors masked failed peers keeps its payload for those peers.
			const payloadSize = recorder.row.payload_size;
			const retentionMaxSize = getPayloadRetentionMaxSize();
			if (typeof payloadSize === 'number' && payloadSize > retentionMaxSize && recorder.getFailedPeers().length === 0) {
				const freed = recorder.dropPayload();
				if (freed > 0) emit('payload_dropped', { payload_size: freed, max_size: retentionMaxSize });
			}
			emit('phase', { phase: 'success', status: 'done' });
			await recorder.finish('success');
		}
		return response;
	} catch (err) {
		// Pack phase, install output tail, and deployment_id into http_resp_msg so the
		// Fastify error handler forwards them verbatim (it does when http_resp_msg is an
		// object). Non-SSE callers see structured failure detail; SSE callers already
		// got the same data live via emit('error', ...) below.
		const capture = installCapture.snapshot();
		const phase = recorder?.row.phase;
		const baseMessage = err?.message ?? String(err);
		const structured = { error: baseMessage };
		if (phase) structured.phase = phase;
		if (capture.lines.length > 0) structured.install_output = capture;
		if (recorder?.deploymentId) structured.deployment_id = recorder.deploymentId;
		// Surface failed peer outcomes so callers see which nodes the deploy did not reach
		// without a second get_deployment round-trip. Populated for replication failures (the
		// throw above) and any other failure that occurred after peers reported. Carried on
		// both the structured non-SSE body and the SSE 'error' event below so the two transports
		// stay symmetric (the CLI uses SSE for deploy_component).
		const failedPeers = recorder?.getFailedPeers() ?? [];
		if (failedPeers.length > 0) structured.failed_peers = failedPeers;

		// Wrap as a ServerError so the Fastify error handler picks a 500 by default; preserve
		// an upstream statusCode (e.g. a ClientError from payload validation) if present.
		const outErr = new ServerError(baseMessage, err?.statusCode);
		outErr.http_resp_msg = structured;

		emit('error', {
			message: baseMessage,
			code: outErr?.statusCode ?? err?.code,
			phase,
			install_output: capture.lines.length > 0 ? capture : undefined,
			deployment_id: recorder?.deploymentId,
			failed_peers: failedPeers.length > 0 ? failedPeers : undefined,
		});
		// Record the terminal failure, but never let a finish() write error (full disk, lock,
		// dropped system table) mask the actual deploy failure — outErr carries the phase,
		// install output, and failed_peers the caller needs.
		if (recorder) {
			try {
				await recorder.finish('failed', err);
			} catch (finishErr) {
				log.warn('Failed to record deployment failure row', finishErr);
			}
		}
		throw outErr;
	}
}

// Ring buffer of install stdout/stderr lines, capped by both line count and bytes so
// a chatty install can't unbounded-grow the error response. snapshot() reports whether
// the head was dropped so callers can flag truncation.
function createInstallCapture(maxLines = 200, maxBytes = 16 * 1024) {
	const lines = [];
	let bytes = 0;
	let dropped = 0;
	return {
		push(manager, stream, line) {
			const entry = { manager, stream, line };
			const size = (line?.length ?? 0) + (stream?.length ?? 0) + (manager?.length ?? 0);
			lines.push(entry);
			bytes += size;
			while (lines.length > 0 && (lines.length > maxLines || bytes > maxBytes)) {
				const evicted = lines.shift();
				bytes -= (evicted.line?.length ?? 0) + (evicted.stream?.length ?? 0) + (evicted.manager?.length ?? 0);
				dropped += 1;
			}
		},
		snapshot() {
			return { lines: lines.slice(), truncated: dropped > 0, dropped_lines: dropped };
		},
	};
}

/**
 * Returns true when the `system` database is configured to replicate from this node.
 * Mirrors the gate `shouldReplicateFromNode` applies for `REPLICATION_DATABASES` (in
 * replication/knownNodes.ts) at the database level. We intentionally do NOT consult
 * peer nodes' configs — handling partial system-replication across an asymmetric
 * cluster is out of scope here; the origin's local view is the canonical signal for
 * whether the payload-via-row path is viable on this node.
 *
 * Treats an unset or wildcard ('*') config as "all databases replicate" (Harper's
 * default), and an array as a strict allowlist where `system` must appear by name
 * (either as a plain string or as `{name: 'system', ...}`).
 */
function isSystemDatabaseReplicated() {
	const databaseReplications = env.get(hdbTerms.CONFIG_PARAMS.REPLICATION_DATABASES);
	// Unset → Harper's default: all databases replicate.
	if (!databaseReplications) return true;
	// Wildcard.
	if (databaseReplications === '*') return true;
	// Single database name (string, not '*'): only THAT database replicates.
	if (typeof databaseReplications === 'string') return databaseReplications === hdbTerms.SYSTEM_SCHEMA_NAME;
	// Array allowlist: 'system' must appear by name (string entry or {name: 'system'} object).
	if (Array.isArray(databaseReplications)) {
		return databaseReplications.some((entry) =>
			typeof entry === 'string' ? entry === hdbTerms.SYSTEM_SCHEMA_NAME : entry?.name === hdbTerms.SYSTEM_SCHEMA_NAME
		);
	}
	// Unknown shape — be conservative and assume not replicated rather than risking a
	// strip that strands peers.
	return false;
}

/**
 * Extracts a project name from the specified package name or URL
 * @param {string} pkg - Package name or URL
 * @returns {string} The project name
 */
function getProjectNameFromPackage(pkg) {
	if (pkg.startsWith('git+ssh://')) {
		return path.basename(pkg.split('#')[0].replace(/\.git$/, ''));
	}

	if (pkg.startsWith('http://') || pkg.startsWith('https://')) {
		return path.basename(new URL(pkg.replace(/\.git$/, '')).pathname);
	}

	if (pkg.startsWith('file://')) {
		try {
			const { name } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
			return path.basename(name);
		} catch {
			//
		}
	}

	return path.basename(pkg);
}

/**
 * Gets a JSON directory tree of the components dir and all nested files/folders
 * @returns {Promise<*>}
 */
async function getComponents() {
	// Recursive function that will traverse the components dir and build json
	// directory tree as it goes.
	const rootConfig = configUtils.getConfiguration();
	const walkDir = async (dir, result) => {
		try {
			const list = await fs.readdir(dir, { withFileTypes: true });
			for (let item of list) {
				const itemName = item.name;
				if (itemName === 'node_modules' || itemName === ASIDE_STAGING_DIR) continue;
				const itemPath = path.join(dir, itemName);
				if (item.isDirectory() || item.isSymbolicLink()) {
					let res = {
						name: itemName,
						entries: [],
					};
					result.entries.push(res);
					await walkDir(itemPath, res);
				} else {
					const stats = await fs.stat(itemPath);
					const res = {
						name: path.basename(itemName),
						mtime: stats.mtime,
						size: stats.size,
					};
					// Flag protected .env files so editors know their contents are masked by
					// get_component_file and only editable via set_env_value. Template files
					// (.env.example / .sample / .template) are not secret, so they are left alone.
					if (isProtectedEnvFile(itemName)) res.protected = true;
					result.entries.push(res);
				}
			}
			return result;
		} catch (error) {
			log.warn('Error loading package', error);
			return { error: error.toString(), entries: [] };
		}
	};

	const results = await walkDir(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), {
		name: configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT).split(path.sep).slice(-1).pop(),
		entries: [],
	});
	const { getUnsatisfiedEnv } = require('./componentSecrets.ts');
	for (let entry of results.entries) {
		// Declared-but-unsatisfied `env:` expectations (#1550) — metadata only (name, description,
		// required, reason, tier), never values — so Studio/deploy output can render configure-me.
		const unsatisfiedEnv = getUnsatisfiedEnv(entry.name);
		if (unsatisfiedEnv.length > 0) entry.unsatisfiedEnv = unsatisfiedEnv;
		const componentConfig = rootConfig?.[entry.name];
		if (!componentConfig || typeof componentConfig !== 'object') continue;
		if (componentConfig.package) entry.package = componentConfig.package;
		if (componentConfig.urlPath) entry.urlPath = componentConfig.urlPath;
		if (componentConfig.host) entry.host = componentConfig.host;
		if (componentConfig.loadComponent) entry.loadComponent = componentConfig.loadComponent;
	}

	const { internal: statusInternal } = require('./status/index.ts');
	let consolidatedStatuses;

	try {
		consolidatedStatuses = await statusInternal.ComponentStatusRegistry.getAggregatedFromAllThreads(
			statusInternal.componentStatusRegistry
		);
	} catch (error) {
		// If we can't get status from threads, continue with unknown statuses
		log.debug(`Failed to get component status from threads: ${error.message}`);
	}

	for (const component of results.entries) {
		try {
			component.status = await statusInternal.componentStatusRegistry.getAggregatedStatusFor(
				component.name,
				consolidatedStatuses
			);
		} catch (error) {
			log.debug(`Failed to get aggregated status for component ${component.name}: ${error.message}`);
			component.status = {
				status: 'unknown',
				message: 'Failed to retrieve component status',
				lastChecked: { workers: {} },
			};
		}
	}
	return results;
}

/**
 * Gets the contents of a component file
 * @param req
 * @returns {Promise<*>}
 */
const DEFAULT_COMPONENT_FILE_MAX_SIZE = 5 * 1024 * 1024; // 5 MB

// Deploys whose payload exceeds this size have their payload_blob dropped after a successful
// deploy (see deployComponent). The metadata is retained; only the tarball bytes are reclaimed.
// Configurable via deployment_payloadRetention_maxSize; set it very high to retain all payloads.
const DEFAULT_PAYLOAD_RETENTION_MAX_SIZE = 10 * 1024 * 1024; // 10 MiB

function getPayloadRetentionMaxSize() {
	const configured = configUtils.getConfigValue(hdbTerms.CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXSIZE);
	// Only a number or a numeric string is a valid threshold. Reject everything else (unset,
	// boolean, array, blank/whitespace string) and fall back to the default — otherwise Number()
	// coercion would turn `true`→1, `false`/``/`[]`→0 into an aggressive always-/near-always-drop.
	if (typeof configured !== 'number' && typeof configured !== 'string') return DEFAULT_PAYLOAD_RETENTION_MAX_SIZE;
	if (typeof configured === 'string' && configured.trim() === '') return DEFAULT_PAYLOAD_RETENTION_MAX_SIZE;
	const parsed = Number(configured);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PAYLOAD_RETENTION_MAX_SIZE;
}

async function getComponentFile(req) {
	const validation = validator.getComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const compRoot = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const filePath = path.join(compRoot, req.project, req.file);
	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };
	const configuredMax = configUtils.getConfigValue(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_COMPONENTFILE_MAXSIZE);
	const maxSize =
		Number.isFinite(+configuredMax) && +configuredMax > 0 ? +configuredMax : DEFAULT_COMPONENT_FILE_MAX_SIZE;

	try {
		const stats = await fs.stat(filePath);
		if (stats.size > maxSize) {
			throw handleHDBError(
				new Error(HDB_ERROR_MSGS.COMPONENT_FILE_TOO_LARGE(stats.size, maxSize)),
				HDB_ERROR_MSGS.COMPONENT_FILE_TOO_LARGE(stats.size, maxSize),
				HTTP_STATUS_CODES.CONTENT_TOO_LARGE
			);
		}
		// Protected .env files expose the key names (and a value-free masked rendering) but never
		// the secret values. Template files (.env.example etc.) fall through and are read verbatim.
		if (isProtectedEnvFile(req.file)) {
			const keys = parseEnvKeys(await fs.readFile(filePath, 'utf8'));
			return {
				protected: true,
				keys,
				message: renderMaskedEnv(keys),
				size: stats.size,
				birthtime: stats.birthtime,
				mtime: stats.mtime,
			};
		}
		return {
			message: await fs.readFile(filePath, options),
			size: stats.size,
			birthtime: stats.birthtime,
			mtime: stats.mtime,
		};
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
			throw new Error(`Component file not found '${path.join(req.project, req.file)}'`);
		}
		throw err;
	}
}

/**
 * Used to update or create a component file
 * @param req
 * @returns {Promise<{message:string}>}
 */
async function setComponentFile(req) {
	const validation = validator.setComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const options = req.encoding ? { encoding: req.encoding } : { encoding: 'utf8' };
	const pathToComp = path.join(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), req.project, req.file);
	if (req.payload !== undefined) {
		await fs.ensureFile(pathToComp);
		await fs.outputFile(pathToComp, req.payload, options);
	} else {
		await fs.ensureDir(pathToComp);
	}
	let response = await server.replication.replicateOperation(req);
	response.message = `Successfully set component: ` + req.file;
	return response;
}

/**
 * Resolve the absolute path of a project's env file (defaulting to `.env`) and confirm it is one.
 * @param req
 * @returns {{file:string, filePath:string}}
 */
function resolveEnvFilePath(req) {
	const file = req.file || '.env';
	if (!isEnvFile(file)) {
		const msg = `'${file}' is not a .env file`;
		throw handleHDBError(new Error(msg), msg, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	const compRoot = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	return { file, filePath: path.join(compRoot, req.project, file) };
}

/**
 * List the key names of a project's .env file. Never returns the secret values.
 * @param req
 * @returns {Promise<{file:string, keys:string[], size:number, mtime:Date}>}
 */
async function getEnvKeys(req) {
	const validation = validator.getEnvKeysValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const { file, filePath } = resolveEnvFilePath(req);
	try {
		const [contents, stats] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
		return { file, keys: parseEnvKeys(contents), size: stats.size, mtime: stats.mtime };
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
			throw new Error(`Component file not found '${path.join(req.project, file)}'`);
		}
		throw err;
	}
}

/**
 * Set one (`key` + `value`) or many (`values`) entries in a project's .env file, preserving all
 * other keys, comments and formatting. Creates the file if it does not exist. Never echoes values.
 * @param req
 * @returns {Promise<{message:string, keys:string[]}>}
 */
async function setEnvValue(req) {
	const validation = validator.setEnvValueValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const { file, filePath } = resolveEnvFilePath(req);
	const updates = req.values ?? { [req.key]: req.value };

	let existing = '';
	try {
		existing = await fs.readFile(filePath, 'utf8');
	} catch (err) {
		if (err.code !== hdbTerms.NODE_ERROR_CODES.ENOENT) throw err;
	}

	let updated;
	try {
		updated = upsertEnvValues(existing, updates);
	} catch (err) {
		throw handleHDBError(err, err.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	await fs.outputFile(filePath, updated, 'utf8');

	const response = await server.replication.replicateOperation(req);
	response.message = `Successfully set env value(s) in ${file}`;
	response.keys = parseEnvKeys(updated);
	return response;
}

/**
 * Remove one (`key`) or many (`keys`) entries from a project's .env file, leaving the rest intact.
 * @param req
 * @returns {Promise<{message:string, keys:string[]}>}
 */
async function deleteEnvValue(req) {
	const validation = validator.deleteEnvValueValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const { file, filePath } = resolveEnvFilePath(req);
	const keysToRemove = req.keys ?? [req.key];

	let existing;
	try {
		existing = await fs.readFile(filePath, 'utf8');
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
			throw new Error(`Component file not found '${path.join(req.project, file)}'`);
		}
		throw err;
	}

	const updated = removeEnvKeys(existing, keysToRemove);
	await fs.outputFile(filePath, updated, 'utf8');

	const response = await server.replication.replicateOperation(req);
	response.message = `Successfully deleted env value(s) from ${file}`;
	response.keys = parseEnvKeys(updated);
	return response;
}

/**
 * Deletes a component dir/file
 * @param req
 * @returns {Promise<{message:string}>}
 */
async function dropComponent(req) {
	const validation = validator.dropComponentFileValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	const { project, file } = req;
	const projectPath = req.file ? path.join(project, file) : project;
	const pathToComponent = path.join(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), projectPath);

	const componentSymlink = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project);
	if (await fs.pathExists(componentSymlink)) {
		await fs.unlink(componentSymlink);
	}

	if (await fs.pathExists(pathToComponent)) {
		await fs.remove(pathToComponent);
	}

	// Remove the component from the package.json file
	const packageJsonPath = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'package.json');
	if (await fs.pathExists(packageJsonPath)) {
		const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
		if (packageJson?.dependencies?.[project]) {
			delete packageJson.dependencies[project];
		}
		await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
	}

	configUtils.deleteConfigFromFile([project]);
	let response = await server.replication.replicateOperation(req);
	if (req.restart === true) {
		manageThreads.restartWorkers('http');
		response.message = `Successfully dropped: ${projectPath}, restarting Harper`;
	} else response.message = `Successfully dropped: ${projectPath}`;
	return response;
}

exports.customFunctionsStatus = customFunctionsStatus;
exports.getCustomFunctions = getCustomFunctions;
exports.getCustomFunction = getCustomFunction;
exports.setCustomFunction = setCustomFunction;
exports.dropCustomFunction = dropCustomFunction;
exports.addComponent = addComponent;
exports.dropCustomFunctionProject = dropCustomFunctionProject;
exports.packageComponent = packageComponent;
exports.deployComponent = deployComponent;
exports.getComponents = getComponents;
exports.getComponentFile = getComponentFile;
exports.setComponentFile = setComponentFile;
exports.getEnvKeys = getEnvKeys;
exports.setEnvValue = setEnvValue;
exports.deleteEnvValue = deleteEnvValue;
exports.dropComponent = dropComponent;
