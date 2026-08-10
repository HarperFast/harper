'use strict';

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
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
const {
	Application,
	prepareApplication,
	stageApplication,
	activateApplication,
	revertApplication,
	stagedApplicationPath,
	hasCompleteStagedApplication,
	activateStagedApplication,
	discardStagedApplication,
	discardProjectStagedApplications,
	discardProjectActivationArtifacts,
	updateApplicationLockEntry,
	createApplicationActivationTransaction,
	ASIDE_STAGING_DIR,
	DEPLOY_STAGING_DIR,
	DEPLOY_ACTIVATION_DIR,
	DEPLOY_PREVIOUS_DIR,
} = require('./Application.ts');
const { COMPONENT_PREPARATION_LOCK_DIR, withComponentPreparationLock } = require('./componentPreparationLock.ts');
const { server } = require('../server/Server.ts');
const {
	DeploymentRecorder,
	awaitDeploymentRow,
	getDeploymentRow,
	markDeploymentTerminal,
	normalizePeerResult,
	recordDeploymentPeers,
	claimStagedDeployment,
	expireOldStagedDeployments,
	invalidateProjectStagedDeployments,
	pruneProjectPayloads,
	readPayloadBlobWithRetry,
	coerceTimeoutMs,
	DEFAULT_AWAIT_ROW_TIMEOUT_MS,
} = require('./deploymentRecorder.ts');
const { ProgressEmitter } = require('../server/serverHelpers/progressEmitter.ts');
const { isOperationAuthorizationBypassed } = require('../server/serverHelpers/operationAuthorizationState.ts');

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
		await invalidateProjectStagedDeployments(project);
		await discardProjectStagedApplications(projectDir);
		await discardProjectActivationArtifacts(projectDir);
		fs.rmSync(projectDir, { recursive: true });
		await updateApplicationLockEntry(project, undefined);
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
 * Deploy a component. Front door for the deploy family: derives the project name, validates, ingests
 * any credential token into the secrets store (so it lives as a replicated reference, not embedded),
 * then dispatches to the two-phase orchestrator (default) or the legacy one-shot path.
 *
 * Two-phase (stage → activate) builds the incoming version into a hidden staging directory on EVERY
 * node first, verifies it landed everywhere, and only then swaps it live cluster-wide — so a node
 * that can't fetch the package or fails `npm install` fails the deploy while the live component is
 * still untouched on every node, and the go-live window shrinks to a fast atomic directory swap.
 * See stageApplication/activateApplication in components/Application.ts.
 *
 * The request/response contract is unchanged: same inputs (`package`/payload, `restart`,
 * `install_*`, `credentials`, `ignore_replication_errors`, `deployment_timeout`, …), same
 * `deployment_id` in the response, same SSE progress stream (now emitting `stage`/`activate` phases
 * instead of `prepare`/`replicate`). Pass `two_phase: false` to force the legacy one-shot path.
 *
 * @param req
 * @returns {Promise<object>}
 */
async function deployComponent(req) {
	if (req.project) {
		req.project = path.parse(req.project).name;
	} else if (req.package) {
		req.project = getProjectNameFromPackage(req.package);
	}

	const isReplicatedExecution = isTrustedReplicatedOperation(req);
	let requestToValidate = req;
	if (isReplicatedExecution) {
		if (req._phase !== undefined) {
			throw new ServerError(
				`Unsupported legacy component deployment phase '${req._phase}'; upgrade the originating node before deploying`
			);
		}
		const { _deploymentId, ...publicRequest } = req;
		requestToValidate = publicRequest;
	}
	const validation = validator.deployComponentValidator(requestToValidate);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}
	const systemReplicated = isSystemDatabaseReplicated();
	const requestedSeparatedPhase = req.activate === false || req.deployment_id !== undefined;
	if (!isReplicatedExecution && req.two_phase === true && req.replicated === false) {
		throw handleHDBError(
			new Error(),
			`two_phase:true requires operation replication to be enabled`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}
	if (!isReplicatedExecution && req.two_phase === true && !systemReplicated) {
		throw handleHDBError(
			new Error(),
			`two_phase:true requires system database replication to be enabled`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}
	if (
		!isReplicatedExecution &&
		requestedSeparatedPhase &&
		(req.two_phase === false || req.replicated === false || !systemReplicated)
	) {
		throw handleHDBError(
			new Error(),
			`activate:false and deployment_id require two-phase deploy with system database replication enabled`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}
	if (req.replicated !== false && !isReplicatedExecution && req.two_phase !== false && systemReplicated) {
		if (req.deployment_id) return deployComponentActivateExisting(req);
		return deployComponentTwoPhase(req);
	}

	// Ingest any provided credential token into the secrets store so the credential lives as
	// replicated ciphertext (reference, not embed); already-reference entries pass through, and with
	// no custody a literal token stays as a transient, this-node-only fallback (#1158). Peers
	// re-running a replicated deploy already carry references and never re-ingest.
	const { ingestCredentials } = require('./secretOperations.ts');
	req.credentials = await ingestCredentials(req, req.credentials, req.project);
	// References are safe to persist (config + deployment row) and replicate; a no-custody literal
	// token is not — it is used only for this node's install, then stripped before replication.
	const credentialReferences = (req.credentials ?? []).filter((entry) => entry && entry.secret !== undefined);

	return deployComponentOneShot(req, credentialReferences, isReplicatedExecution);
}

/**
 * A genuinely-new (never-loaded) component deployed without an immediate restart can't serve its
 * routes until Harper restarts, so mark a restart as needed (harper#674). This is the setter only; it
 * does not itself restart — it makes get_status report restartRequired:true and lets the REST
 * route-miss path surface the actionable "needs a restart" 404. Scoped to new components (harper#1806):
 * an existing, already-loaded component's own file watcher independently requests a restart if a
 * redeploy actually needs one, so a redeploy stays quiet. Runs per node — each node checks its own
 * isNewComponent, since directory state (new vs. redeploy) can differ across the cluster. The one-shot
 * path has extractApplication set isNewComponent in place; the two-phase path has activateApplication
 * set it at swap time (staging is always fresh, so extract never sees the live dir).
 */
function markRestartRequiredForNewComponent(application) {
	if (application.isNewComponent) {
		const { requestRestart } = require('./requestRestart.ts');
		requestRestart();
	}
}

/**
 * Legacy one-shot deploy: extract + `npm install` in place on the origin, then replicate the whole
 * deploy_component operation to peers, which each do the same. Preserved verbatim (behavior-for-
 * behavior) as the fallback path for `two_phase: false` and for peers replaying a one-shot deploy.
 * The wrapper has already derived the project name, validated, and ingested credentials.
 */
async function deployComponentOneShot(req, credentialReferences, isReplicatedExecution) {
	const { resolveCredentials } = require('./secretOperations.ts');

	// Write to root config if the request contains a package identifier
	if (req.package) await writeComponentRootConfig(req, credentialReferences);

	// Create a hdb_deployment row up front so the deploy is observable and auditable even if the CLI
	// disconnects. The row also holds the payload in a Blob attribute, which doubles as the source for
	// peer replication and (later) rollback. Only the origin node records — peers replaying the
	// replicated deploy skip recording so we don't accumulate one row per node for the same deploy.
	// An SSE-bound caller already attached a ProgressEmitter (created in the server handler so it can
	// also drive the response stream). Reuse it; otherwise spin up a fresh emitter so the recorder
	// still gets phase events for non-SSE deploys.
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

	// The payload-via-replicated-row path depends on `system` actually replicating on this node.
	const systemReplicated = isSystemDatabaseReplicated();

	// Bounded ring buffer of install stdout/stderr so a non-SSE caller sees the tail in the thrown
	// error. SSE callers still stream every line live.
	const installCapture = createInstallCapture();
	try {
		const extractionPayload = await sourceExtractionPayload({ req, recorder, isReplicatedExecution });
		const resolvedCredentials = await resolveNodeCredentials({ req, resolveCredentials, isReplicatedExecution });
		const application = buildDeployApplication({
			req,
			extractionPayload,
			resolvedCredentials,
			installCapture,
			emitter,
			emit,
		});
		// Reduce req.credentials to references only (never a token) before it can reach an error/log
		// path or replication: references are what peers resolve from their own replicated hdb_secret
		// copy; a no-custody literal token is dropped entirely (peers fall back to their fabric-injected
		// NPM_CONFIG_USERCONFIG, as before).
		if (credentialReferences.length) req.credentials = credentialReferences;
		else delete req.credentials;

		emit('phase', { phase: 'prepare', status: 'start' });
		await prepareApplication(application);
		emit('phase', { phase: 'prepare', status: 'done' });

		// Load the component to surface load-time errors early (throwaway scopes; see loadValidateComponent).
		await loadValidateComponent({ dirPath: application.dirPath, emit });

		const rollingRestart = req.restart === 'rolling';
		// if doing a rolling restart set restart to false so that other nodes don't also restart.
		req.restart = rollingRestart ? false : req.restart;
		// ProgressEmitter holds function listeners that can't survive the replication channel's
		// serialization; strip it unconditionally.
		delete req.progress;
		if (systemReplicated && recorder) {
			// The hdb_deployment row + payload_blob reach peers via table replication, so peers look up
			// the payload by deployment_id. Drop req.payload to keep the operation body small.
			delete req.payload;
		}
		const onPeerResult = recorder
			? (result) => {
					recorder.recordPeer(result);
					emit('peer', result);
				}
			: undefined;
		// Seal before the replicate phase so the row's terminal write (finish()) isn't part of the tight
		// put burst that can commit out of order on a peer and revert it (harperdb/harper#1170).
		recorder?.seal();
		emit('phase', { phase: 'replicate', status: 'start' });
		let response = await server.replication.replicateOperation(req, { onPeerResult });
		emit('phase', { phase: 'replicate', status: 'done' });
		if (recorder && response?.replicated) {
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
		} else {
			// Deployed without restarting: for a component that had no directory before this
			// deploy — genuinely new, never loaded — its routes cannot be live until Harper
			// restarts, so mark a restart as needed. This is the setter only; it does not itself
			// restart. It makes get_status report restartRequired:true and lets the REST
			// route-miss path surface the actionable "needs a restart" 404 for a freshly deployed,
			// never-loaded component (harper#674). Runs per-node: a peer applying the replicated
			// deploy checks its own local isNewComponent, since directory state (and therefore
			// whether the component was already active) can differ per node.
			//
			// An existing, already-active component being redeployed does NOT force a restart
			// here: some updates (e.g. static files only) may not need one at all, and when one
			// genuinely is needed, that component's already-running file watcher (Scope/
			// EntryHandler, see deployLifecycle.ts) independently detects the post-deploy file
			// changes and requests the restart itself.
			markRestartRequiredForNewComponent(application);
			response.message = `Successfully deployed: ${application.name}`;
		}

		// Replication failures don't reject replicateOperation — they surface as 'failed' entries in
		// peer_results. By default, treat any failed peer as an overall deploy failure so the operation
		// returns a non-2xx status. Pass ignore_replication_errors: true for best-effort deploys.
		if (recorder && !req.ignore_replication_errors) {
			const failedPeers = recorder.getFailedPeers();
			if (failedPeers.length > 0) {
				throw new ServerError(
					`Component '${application.name}' was deployed on the origin node but failed to replicate to ` +
						`${failedPeers.length} of ${recorder.row.peer_results.length} peer node(s): ${describePeers(failedPeers)}. ` +
						`See deployment ${recorder.deploymentId} (get_deployment) for details, or pass ` +
						`ignore_replication_errors: true to treat replication failures as non-fatal.`
				);
			}
		}

		if (recorder) {
			response.deployment_id = recorder.deploymentId;
			maybeReclaimPayload(recorder, emit);
			emit('phase', { phase: 'success', status: 'done' });
			await recorder.finish('success');
			// After finish(), so this deploy's row is terminal and counts as the newest retained payload.
			schedulePayloadRetentionPrune(recorder, req.project, emit);
		}
		return response;
	} catch (err) {
		throw await finalizeDeployFailure({ err, recorder, installCapture, emit });
	}
}

/**
 * Two-phase deploy orchestrator (origin node). Builds the incoming version into staging on every
 * node (phase 1, stage_component), gates on every node succeeding, then atomically swaps it live on
 * every node (phase 2, activate_component). The live component on every node is untouched until the
 * whole cluster has the bits in place, and the go-live window is just the swap + restart.
 */
async function _legacyDeployComponentTwoPhase(req, credentialReferences) {
	const { resolveCredentials } = require('./secretOperations.ts');
	// Fail fast on a protected core name before we create any state or touch the cluster.
	if (req.package) assertNotProtectedCoreComponent(req.project, req.force);

	// The origin always records (a two-phase origin is never itself a replicated execution).
	const emitter = req.progress ?? new ProgressEmitter();
	if (!req.progress) req.progress = emitter;
	const recorder = await DeploymentRecorder.create({
		project: req.project,
		package_identifier: req.package ?? null,
		user: req.hdb_user?.username,
		restart_mode: req.restart === 'rolling' ? 'rolling' : req.restart ? 'immediate' : null,
		credentials: credentialReferences.length ? credentialReferences : null,
		emitter,
	});
	req._deploymentId = recorder.deploymentId;
	const emit = (event, data) => emitter.emit(event, data);
	const installCapture = createInstallCapture();
	const rollingRestart = req.restart === 'rolling';
	const recordPeer = (result) => {
		recorder.recordPeer(result);
		emit('peer', result);
	};
	let application;

	try {
		// Tee the payload into the row's blob (the replication channel peers read from) and re-source
		// extraction from it. Two-phase requires systemReplicated, so peers always fetch from the row.
		const extractionPayload = await sourceExtractionPayload({ req, recorder, isReplicatedExecution: false });
		const resolvedCredentials = await resolveNodeCredentials({ req, resolveCredentials, isReplicatedExecution: false });
		// stagingId = deployment id so peers (which build a fresh Application per sub-op) resolve the
		// same staging path this deployment used.
		application = buildDeployApplication({
			req,
			extractionPayload,
			resolvedCredentials,
			stagingId: recorder.deploymentId,
			installCapture,
			emitter,
			emit,
		});
		// Strip tokens from req before any replication/log path; keep references (peers resolve those
		// from their own hdb_secret copy). Strip the emitter and payload too — peers read the payload
		// from the replicated row, keeping the sub-operation bodies small.
		if (credentialReferences.length) req.credentials = credentialReferences;
		else delete req.credentials;
		delete req.progress;
		delete req.payload;

		// ===== PHASE 1: STAGE — build on every node; nothing goes live. =====
		emit('phase', { phase: 'stage', status: 'start' });
		await stageApplication(application);
		const stageOp = buildReplicatedSubOp(req, hdbTerms.OPERATIONS_ENUM.DEPLOY_COMPONENT, { phase: 'stage' });
		const stageResp = await server.replication.replicateOperation(stageOp, { onPeerResult: recordPeer });
		if (stageResp?.replicated) recorder.recordPeers(stageResp.replicated);
		emit('phase', { phase: 'stage', status: 'done' });

		// ---- Cluster barrier: every node must have staged before ANY node activates. ----
		if (!req.ignore_replication_errors) {
			const failed = recorder.getFailedPeers();
			if (failed.length > 0) {
				await discardStagedApplication(application).catch(() => {});
				throw new ServerError(
					`Component '${req.project}' failed to stage on ${failed.length} of ` +
						`${recorder.row.peer_results.length} peer node(s): ${describePeers(failed)}. No node was activated — ` +
						`the live component is unchanged everywhere. See deployment ${recorder.deploymentId} (get_deployment), ` +
						`or pass ignore_replication_errors: true to activate the nodes that did stage.`
				);
			}
		}

		// Validate the staged build before go-live (loads from the staging dir; see loadValidateComponent).
		await loadValidateComponent({ dirPath: application.buildDirPath, emit });

		// `activate: false` — stage-and-stop. The build is verified on every node; leave the row in a
		// `staged` state and return its deployment_id so a later deploy_component({deployment_id}) can
		// take it live. Nothing has gone live anywhere.
		if (req.activate === false) {
			emit('phase', { phase: 'staged', status: 'done' });
			await recorder.finish('staged');
			return {
				message: `Staged component: ${application.name}`,
				project: application.name,
				staged: true,
				deployment_id: recorder.deploymentId,
			};
		}

		// ===== PHASE 2: ACTIVATE — atomic swap + restart, now the bits are in place everywhere. =====
		// Persist root config now (not before staging) so a `package` config never points at a version
		// that failed to stage.
		if (req.package) await writeComponentRootConfig(req, credentialReferences);
		// if doing a rolling restart set restart to false so peers don't also immediately restart.
		req.restart = rollingRestart ? false : req.restart;

		emit('phase', { phase: 'activate', status: 'start' });
		await activateApplication(application);
		const activateOp = buildReplicatedSubOp(req, hdbTerms.OPERATIONS_ENUM.DEPLOY_COMPONENT, {
			phase: 'activate',
			restart: req.restart,
			deploymentId: recorder.deploymentId,
		});
		// Seal before the activate replicate burst (same #1170 rationale as one-shot).
		recorder.seal();
		const activateResp = await server.replication.replicateOperation(activateOp, { onPeerResult: recordPeer });
		emit('phase', { phase: 'activate', status: 'done' });
		let response = activateResp && typeof activateResp === 'object' ? activateResp : { message: '' };
		if (activateResp?.replicated) recorder.recordPeers(activateResp.replicated);

		// ---- Restart on the origin. ----
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
		} else {
			// No restart requested: a genuinely-new component still needs one to serve its routes
			// (harper#674). activateApplication set isNewComponent from the pre-swap live dir above.
			markRestartRequiredForNewComponent(application);
			response.message = `Successfully deployed: ${application.name}`;
		}

		// ---- Activate gate: rare, but a node can stage OK and then fail the swap. ----
		await enforceActivatePeerGate({
			req,
			application,
			emit,
			failed: recorder.getFailedPeers(),
			totalPeers: recorder.row.peer_results.length,
			deploymentId: recorder.deploymentId,
		});

		response.deployment_id = recorder.deploymentId;
		maybeReclaimPayload(recorder, emit);
		emit('phase', { phase: 'success', status: 'done' });
		await recorder.finish('success');
		// After finish(), so this deploy's row is terminal and counts as the newest retained payload.
		schedulePayloadRetentionPrune(recorder, req.project, emit);
		return response;
	} catch (err) {
		// An aborted deploy leaves the live component untouched; drop any staged build so it can't leak.
		if (application) await discardStagedApplication(application).catch(() => {});
		throw await finalizeDeployFailure({ err, recorder, installCapture, emit });
	}
}

/**
 * Peer stage phase (internal — NOT a public operation). Runs on a peer when the origin fans out
 * deploy_component tagged `_phase: 'stage'`: fetch the tarball from the replicated hdb_deployment row,
 * build + `npm install` into the hidden staging directory, and load-validate — never touching the live
 * path, writing config, or restarting. A failure here fails this peer's stage, which the origin's
 * barrier catches. No recorder (the origin owns the row) and no re-replication.
 */
async function _legacyDeployPhaseStage(req) {
	const { resolveCredentials } = require('./secretOperations.ts');
	const emitter = null; // peers stream nothing back; the origin owns the emitter/recorder
	const emit = () => {};
	const installCapture = createInstallCapture();
	let application;
	try {
		const extractionPayload = await sourceExtractionPayload({ req, recorder: null, isReplicatedExecution: true });
		const resolvedCredentials = await resolveNodeCredentials({ req, resolveCredentials, isReplicatedExecution: true });
		application = buildDeployApplication({
			req,
			extractionPayload,
			resolvedCredentials,
			stagingId: req._deploymentId,
			installCapture,
			emitter,
			emit,
		});
		await stageApplication(application);
		// Surface load-time errors on the staged build (no-op on the main thread, where replicated peer
		// executions run — app code must not load there; see loadValidateComponent + DESIGN.md).
		await loadValidateComponent({ dirPath: application.buildDirPath, emit });
		return { message: `Staged component: ${req.project}`, project: req.project, staged: true };
	} catch (err) {
		if (application) await discardStagedApplication(application).catch(() => {});
		throw await finalizeDeployFailure({ err, recorder: null, installCapture, emit });
	}
}

/**
 * Peer activate phase (internal — NOT a public operation). Runs on a peer when the origin fans out
 * deploy_component tagged `_phase: 'activate'`: atomically swap the already-staged build (by deployment
 * id) into the live path, persist root config for a package deploy, and restart if the origin asked
 * for an immediate restart. No recorder, no re-replication.
 */
async function _legacyDeployPhaseActivate(req) {
	if (req.package) assertNotProtectedCoreComponent(req.project, req.force);
	const credentialReferences = (req.credentials ?? []).filter((entry) => entry && entry.secret !== undefined);
	const application = new Application({
		name: req.project,
		packageIdentifier: req.package,
		stagingId: req._deploymentId,
	});
	await activateApplication(application);
	if (req.package) await writeComponentRootConfig(req, credentialReferences);
	// The origin sets restart=true on the sub-op only for an immediate restart; rolling restarts are
	// driven separately by the origin via a replicated restart_service job.
	if (req.restart === true) manageThreads.restartWorkers('http');
	// Not restarting now: mark restart-required per node for a genuinely-new component (harper#674), the
	// same marking the one-shot peer path does — so a new component deployed cluster-wide with
	// restart:false reports restartRequired on every node, not just the origin. A rolling restart, which
	// also arrives here with restart:false, clears the flag when it reaches this node.
	else markRestartRequiredForNewComponent(application);
	return { message: `Activated component: ${req.project}`, project: req.project, activated: true };
}

/**
 * Activate a previously-staged deployment cluster-wide — the second half of a stage-then-activate
 * flow, reached as `deploy_component({ deployment_id })` with no fresh payload. Swaps the staged build
 * into the live path on the origin, replicates the activate phase to peers (each activates its own
 * staged copy of the same deployment id), restarts, and marks the deployment row success.
 */
async function _legacyDeployComponentActivateExisting(req, credentialReferences) {
	const stagingId = req.deployment_id;
	// An activate-by-id call carries no `package` — `harper activate` sends only project + deployment_id,
	// and the docs describe this path as fetching/installing nothing — so recover the staged deployment's
	// package identifier and credential references from its row. Without this, a component staged as a
	// `package` deploy and activated later would never persist its root-config entry: not on the origin
	// (writeComponentRootConfig is gated on `req.package`) and not on any peer either, since the fanned-out
	// sub-op copies `package`/`credentials` from this same `req`. The package reference and the credential
	// references that cold reinstalls and newly-joined peers depend on would be silently lost, leaving the
	// component recorded as a plain directory. Explicit values on the request always win.
	if (!req.package) {
		const stagedRow = await getDeploymentRow(stagingId).catch((err) => {
			log.warn(`Could not read deployment ${stagingId} to recover its package identifier`, err);
			return undefined;
		});
		if (stagedRow?.package_identifier) {
			req.package = stagedRow.package_identifier;
			// The row stores credential REFERENCES (tokens were never persisted), which is exactly what
			// root config should carry. Only fall back to them when the caller supplied none.
			if (!req.credentials?.length && Array.isArray(stagedRow.credentials) && stagedRow.credentials.length) {
				req.credentials = stagedRow.credentials;
			}
			credentialReferences = (req.credentials ?? []).filter((entry) => entry && entry.secret !== undefined);
		}
	}
	if (req.package) assertNotProtectedCoreComponent(req.project, req.force);
	const emitter = req.progress ?? new ProgressEmitter();
	if (!req.progress) req.progress = emitter;
	const emit = (event, data) => emitter.emit(event, data);
	const rollingRestart = req.restart === 'rolling';
	const application = new Application({ name: req.project, packageIdentifier: req.package, stagingId });

	emit('phase', { phase: 'activate', status: 'start' });
	await activateApplication(application);
	emit('phase', { phase: 'activate', status: 'done' });
	// Persist root config now that the component is live (package deploys).
	if (req.package) await writeComponentRootConfig(req, credentialReferences);

	// Replicate the activate phase to peers (each activates its own staged copy of this deployment id).
	req._deploymentId = stagingId;
	delete req.progress;
	const activateOp = buildReplicatedSubOp(req, hdbTerms.OPERATIONS_ENUM.DEPLOY_COMPONENT, {
		phase: 'activate',
		restart: rollingRestart ? false : req.restart,
		deploymentId: stagingId,
	});
	// Collect per-peer outcomes so a partially-failed activate can be gated below. There is no
	// DeploymentRecorder on this path (the row was created and finished as `staged` by the earlier
	// stage-and-stop), so a local collector stands in for recorder.recordPeer/getFailedPeers.
	const peers = createPeerResultCollector();
	const rep = await server.replication.replicateOperation(activateOp, {
		onPeerResult: (result) => {
			peers.record(result);
			emit('peer', result);
		},
	});
	if (rep?.replicated) peers.recordAll(rep.replicated);

	const response = {
		message: `Activated component: ${req.project}`,
		project: req.project,
		activated: true,
		deployment_id: stagingId,
	};
	if (rep?.replicated) response.replicated = rep.replicated;

	if (req.restart === true) {
		emit('phase', { phase: 'restart', status: 'start' });
		manageThreads.restartWorkers('http');
		emit('phase', { phase: 'restart', status: 'done' });
		response.message = `Activated component: ${req.project}, restarting Harper`;
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
		response.message = `Activated component: ${req.project}, restarting Harper`;
	} else {
		// No restart requested: activating a genuinely-new component still needs one to serve its routes
		// (harper#674). activateApplication set isNewComponent from the pre-swap live dir above.
		markRestartRequiredForNewComponent(application);
	}

	// ---- Activate gate: a peer can hold a good staged build and still fail the swap. Same gate the
	// two-phase activate phase uses, so revert_on_failure / ignore_replication_errors behave identically
	// whether the activate came from a full deploy or from `deploy_component({ deployment_id })`.
	try {
		await enforceActivatePeerGate({
			req,
			application,
			emit,
			failed: peers.getFailed(),
			totalPeers: peers.total,
			deploymentId: stagingId,
		});
	} catch (err) {
		// The origin went live but the cluster did not converge — record the terminal state before
		// surfacing the failure, so get_deployment doesn't still read `staged`.
		await markDeploymentTerminal(stagingId, 'failed').catch((markErr) =>
			log.warn('Failed to mark deployment as failed after a partial activate', markErr)
		);
		throw err;
	}

	// Best-effort: flip the staged deployment row (left 'staged' by the stage-and-stop) to success now
	// that it is live. Observability only — a tracking-write failure must not fail the activate.
	await markDeploymentTerminal(stagingId, 'success').catch((err) =>
		log.warn('Failed to mark staged deployment as activated', err)
	);
	return response;
}

/**
 * revert_component — swap a component's live version back to its retained previous version
 * (`.deploy-previous/<name>`, kept by the last activate), cluster-wide, then restart. Backs
 * customer-driven rollback (deploy → run your own health checks → revert if unhappy) and a
 * swap-back after a partially-failed activate. The swap is bidirectional, so reverting a revert
 * rolls forward again.
 *
 * Reached two ways: directly by an operator, and by a peer replaying a replicated revert
 * (`_deploymentId` set). deploy_component's `revert_on_failure` path drives it internally.
 */
function activationSpecFromRequest(req, credentialReferences) {
	return {
		project: req.project,
		package: req.package ?? null,
		install_command: req.install_command ?? null,
		install_timeout: req.install_timeout ?? null,
		install_allow_scripts: req.install_allow_scripts ?? null,
		urlPath: req.urlPath ?? null,
		host: req.host ?? null,
		credentials: credentialReferences.length ? credentialReferences : null,
		force: req.force === true,
	};
}

function applicationFromSpec(spec, payload, resolvedCredentials, installCapture, emit) {
	return new Application({
		name: spec.project,
		payload,
		packageIdentifier: spec.package ?? undefined,
		install: {
			command: spec.install_command ?? undefined,
			timeout: spec.install_timeout ?? undefined,
			allowInstallScripts: spec.install_allow_scripts ?? undefined,
		},
		credentials: resolvedCredentials,
		onInstallLine: (manager, stream, line) => {
			installCapture?.push(manager, stream, line);
			emit?.('install', { manager, stream, line });
		},
	});
}

function failedPeerResults(results) {
	return (results ?? []).filter((result) => result?.status === 'failed' || result?.error || result?.reason);
}

function describePeerFailures(failed) {
	return failed
		.map((peer) => `${peer.node ?? 'unknown'} (${peer.error?.message ?? peer.reason ?? 'unknown error'})`)
		.join(', ');
}

function buildPhaseOperation(phase, deploymentId, project, activationSpec, extra = {}) {
	return {
		operation: hdbTerms.OPERATIONS_ENUM.COMPONENT_DEPLOY_PHASE,
		phase,
		deployment_id: deploymentId,
		project,
		activation_spec: activationSpec,
		...extra,
	};
}

async function resolveSpecCredentials(spec, waitMs = 0) {
	const { resolveCredentials } = require('./secretOperations.ts');
	return resolveCredentials(spec.credentials ?? [], spec.project, { waitMs });
}

function assertStoredActivationSpec(row, deploymentId, project, spec, allowedStatuses) {
	if (
		!row ||
		row.project !== project ||
		!allowedStatuses.includes(row.status) ||
		!isDeepStrictEqual(row.activation_spec, spec)
	) {
		throw new ServerError(
			`Deployment '${deploymentId}' does not have the expected immutable activation specification for '${project}'`
		);
	}
}

async function sourceStagedPayload(deploymentId, spec, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	const row = await awaitDeploymentRow(deploymentId, { timeoutMs, requirePayload: !spec.package });
	assertStoredActivationSpec(row, deploymentId, spec.project, spec, ['pending', 'staging', 'staged', 'activating']);
	if (spec.package) return undefined;
	return readPayloadBlobWithRetry(() => row.payload_blob.stream(), {
		timeoutMs: Math.max(0, deadline - Date.now()),
	});
}

async function discardDeploymentEverywhere(project, deploymentId, activationSpec) {
	const componentPath = path.join(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), project);
	await discardStagedApplication(componentPath, deploymentId).catch(() => {});
	await server.replication
		.replicateOperation(buildPhaseOperation('discard', deploymentId, project, activationSpec))
		.catch(() => {});
}

function getStagingRetentionMaxCount() {
	const value = Number(env.get(hdbTerms.CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT));
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 5;
}

function getPayloadRetentionMaxCount() {
	const value = Number(env.get(hdbTerms.CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXCOUNT));
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

async function pruneStagedDeploymentArtifacts(project, activationSpec) {
	const expired = await expireOldStagedDeployments(project, getStagingRetentionMaxCount());
	for (const deploymentId of expired) await discardDeploymentEverywhere(project, deploymentId, activationSpec);
}

async function restartActivatedComponent(req, deploymentId, project, activationSpec, emit) {
	if (req.restart === true) {
		emit('phase', { phase: 'restart', status: 'start' });
		const restartResponse = await server.replication.replicateOperation(
			buildPhaseOperation('restart', deploymentId, project, activationSpec)
		);
		const failed = failedPeerResults(restartResponse?.replicated);
		manageThreads.restartWorkers('http');
		emit('phase', { phase: 'restart', status: 'done' });
		return { restartMessage: `, restarting Harper`, replicated: restartResponse?.replicated, failedPeers: failed };
	}
	if (req.restart === 'rolling') {
		const serverUtilities = require('../server/serverHelpers/serverUtilities.ts');
		emit('phase', { phase: 'restart', status: 'start' });
		const jobResponse = await serverUtilities.executeJob({
			operation: 'restart_service',
			service: 'http',
			replicated: true,
		});
		emit('phase', { phase: 'restart', status: 'done' });
		return { restartMessage: `, restarting Harper`, restartJobId: jobResponse.job_id, failedPeers: [] };
	}
	return { restartMessage: '', failedPeers: [] };
}

async function deployComponentTwoPhase(req) {
	assertNotProtectedCoreComponent(req.project, req.force);
	const { ingestCredentials, resolveCredentials } = require('./secretOperations.ts');
	req.credentials = await ingestCredentials(req, req.credentials, req.project);
	const credentialReferences = (req.credentials ?? []).filter((entry) => entry?.secret !== undefined);
	const activationSpec = activationSpecFromRequest(req, credentialReferences);
	const emitter = req.progress ?? new ProgressEmitter();
	const emit = (event, data) => emitter.emit(event, data);
	const installCapture = createInstallCapture();
	const recorder = await DeploymentRecorder.create({
		project: req.project,
		package_identifier: req.package ?? null,
		user: req.hdb_user?.username,
		restart_mode: req.restart === 'rolling' ? 'rolling' : req.restart ? 'immediate' : null,
		credentials: credentialReferences.length ? credentialReferences : null,
		activation_spec: activationSpec,
		emitter,
	});
	let application;
	let activationCommitted = false;
	let activationBarrierPassed = false;
	try {
		let payload = req.payload;
		if (req.payload != null) {
			await recorder.ingestPayload(req.payload);
			payload = recorder.row.payload_blob.stream();
		}
		const resolvedCredentials = await resolveCredentials(req.credentials, req.project);
		application = applicationFromSpec(activationSpec, payload, resolvedCredentials, installCapture, emit);
		if (credentialReferences.length) req.credentials = credentialReferences;
		else delete req.credentials;
		delete req.progress;
		delete req.payload;

		emit('phase', { phase: 'stage', status: 'start' });
		const stagedPath = await stageApplication(application, recorder.deploymentId);
		await loadValidateComponent({ dirPath: stagedPath, emit });
		recorder.seal();
		const stageResponse = await server.replication.replicateOperation(
			buildPhaseOperation('stage', recorder.deploymentId, req.project, activationSpec, {
				deployment_timeout: req.deployment_timeout,
			}),
			{
				onPeerResult: (result) => {
					recorder.recordPeer(result);
					emit('peer', result);
				},
			}
		);
		if (stageResponse?.replicated) recorder.recordPeers(stageResponse.replicated);
		emit('phase', { phase: 'stage', status: 'done' });
		const stageFailures = recorder.getFailedPeers();
		if (stageFailures.length && !req.ignore_replication_errors) {
			await discardDeploymentEverywhere(req.project, recorder.deploymentId, activationSpec);
			throw new ServerError(
				`Component '${req.project}' failed to stage on ${stageFailures.length} peer node(s): ` +
					`${describePeerFailures(stageFailures)}. No node was activated and the live component is unchanged.`
			);
		}
		await recorder.checkpoint('staged', 'staged');

		if (req.activate === false) {
			emit('phase', { phase: 'staged', status: 'done' });
			await recorder.finish('staged');
			await pruneStagedDeploymentArtifacts(req.project, activationSpec);
			await pruneProjectPayloads(req.project, getPayloadRetentionMaxCount()).catch((error) =>
				log.warn('Failed to prune staged deployment payloads', error)
			);
			return {
				message: `Staged component: ${req.project}`,
				project: req.project,
				staged: true,
				deployment_id: recorder.deploymentId,
				replicated: stageResponse?.replicated,
				...(stageFailures.length ? { failed_peers: stageFailures } : {}),
			};
		}

		const configTransaction = await createApplicationActivationTransaction(req.project, activationSpec);
		await activateStagedApplication(application, recorder.deploymentId, {
			beforeSwap: async () => {
				await claimStagedDeployment(recorder.deploymentId, req.project);
				emit('phase', { phase: 'activate', status: 'start' });
			},
			beforeCommit: () => configTransaction.commit(),
			onRollback: () => configTransaction.rollback(),
		});
		activationCommitted = true;
		const activateResponse = await server.replication.replicateOperation(
			buildPhaseOperation('activate', recorder.deploymentId, req.project, activationSpec),
			{
				onPeerResult: (result) => {
					recorder.recordPeer(result);
					emit('peer', result);
				},
			}
		);
		if (activateResponse?.replicated) recorder.recordPeers(activateResponse.replicated);
		emit('phase', { phase: 'activate', status: 'done' });
		const activateFailures = recorder.getFailedPeers();
		if (activateFailures.length && !req.ignore_replication_errors) {
			throw new ServerError(
				`Component '${req.project}' activated on only part of the cluster. Split nodes: ` +
					`${describePeerFailures(activateFailures)}. Roll forward by staging and activating a known-good deployment.`
			);
		}
		activationBarrierPassed = activateFailures.length === 0;
		if (!req.restart) markRestartRequiredForNewComponent(application);
		const restart = await restartActivatedComponent(req, recorder.deploymentId, req.project, activationSpec, emit);
		if (restart.failedPeers.length) recorder.recordPeers(restart.failedPeers);
		if (restart.failedPeers.length && !req.ignore_replication_errors) {
			throw new ServerError(
				`Component '${req.project}' activated, but restart failed on: ${describePeerFailures(restart.failedPeers)}`
			);
		}
		emit('phase', { phase: 'success', status: 'done' });
		maybeReclaimPayload(recorder, emit);
		await recorder.finish('success');
		await pruneProjectPayloads(req.project, getPayloadRetentionMaxCount()).catch((error) =>
			log.warn('Failed to prune deployment payloads', error)
		);
		return {
			message: `Successfully deployed: ${req.project}${restart.restartMessage}`,
			project: req.project,
			deployment_id: recorder.deploymentId,
			replicated: activateResponse?.replicated,
			...(restart.restartJobId ? { restartJobId: restart.restartJobId } : {}),
			...(recorder.getFailedPeers().length ? { failed_peers: recorder.getFailedPeers() } : {}),
		};
	} catch (error) {
		if (application && !activationCommitted) {
			await discardStagedApplication(application.dirPath, recorder.deploymentId).catch(() => {});
		}
		const capture = installCapture.snapshot();
		const failedPeers = recorder.getFailedPeers();
		const message = error?.message ?? String(error);
		const structured = {
			error: message,
			phase: recorder.row.phase,
			deployment_id: recorder.deploymentId,
			...(capture.lines.length ? { install_output: capture } : {}),
			...(failedPeers.length ? { failed_peers: failedPeers } : {}),
		};
		emit('error', {
			message,
			code: error?.statusCode ?? error?.code,
			phase: recorder.row.phase,
			deployment_id: recorder.deploymentId,
			install_output: capture.lines.length ? capture : undefined,
			failed_peers: failedPeers.length ? failedPeers : undefined,
		});
		await recorder
			.finish(activationBarrierPassed ? 'success' : activationCommitted ? 'activating' : 'failed', error)
			.catch((finishError) => log.warn('Failed to record two-phase deployment failure', finishError));
		const outError = new ServerError(message, error?.statusCode);
		outError.http_resp_msg = structured;
		throw outError;
	}
}

const ACTIVATION_FRESH_FIELDS = [
	'payload',
	'package',
	'install_command',
	'install_timeout',
	'install_allow_scripts',
	'urlPath',
	'host',
	'credentials',
	'force',
	'activate',
	'two_phase',
];

function assertActivationRequestIsReferenceOnly(req) {
	const supplied = ACTIVATION_FRESH_FIELDS.filter((field) => req[field] !== undefined);
	if (supplied.length) {
		throw handleHDBError(
			new Error(),
			`deployment_id activation uses the immutable staged configuration; remove: ${supplied.join(', ')}`,
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}
}

async function deployComponentActivateExisting(req) {
	assertActivationRequestIsReferenceOnly(req);
	const row = await getDeploymentRow(req.deployment_id);
	if (!row) throw handleHDBError(new Error(), `No deployment found with id '${req.deployment_id}'`, 404);
	if (row.project !== req.project || row.status !== 'staged' || !row.activation_spec) {
		throw handleHDBError(
			new Error(),
			`Deployment '${req.deployment_id}' is not a staged deployment for component '${req.project}'`,
			HTTP_STATUS_CODES.CONFLICT
		);
	}
	const spec = row.activation_spec;
	assertNotProtectedCoreComponent(spec.project, spec.force);
	const emitter = req.progress ?? new ProgressEmitter();
	const emit = (event, data) => emitter.emit(event, data);
	const componentPath = path.join(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), req.project);
	let application;
	const stagedPath = stagedApplicationPath(componentPath, req.deployment_id);
	if (await hasCompleteStagedApplication(stagedPath)) {
		application = applicationFromSpec(spec, undefined, undefined, null, emit);
		await loadValidateComponent({ dirPath: stagedPath, emit });
	} else {
		const timeoutMs = coerceTimeoutMs(req.deployment_timeout, DEFAULT_AWAIT_ROW_TIMEOUT_MS);
		const payload = await sourceStagedPayload(req.deployment_id, spec, timeoutMs);
		const credentials = await resolveSpecCredentials(spec, timeoutMs);
		application = applicationFromSpec(spec, payload, credentials, createInstallCapture(), emit);
		const rebuiltPath = await stageApplication(application, req.deployment_id);
		await loadValidateComponent({ dirPath: rebuiltPath, emit });
	}
	const configTransaction = await createApplicationActivationTransaction(req.project, spec);
	emit('phase', { phase: 'activate', status: 'start' });
	let claimed = false;
	try {
		await activateStagedApplication(application, req.deployment_id, {
			beforeSwap: async () => {
				await claimStagedDeployment(req.deployment_id, req.project);
				claimed = true;
			},
			beforeCommit: () => configTransaction.commit(),
			onRollback: () => configTransaction.rollback(),
		});
	} catch (error) {
		if (claimed) await markDeploymentTerminal(req.deployment_id, 'staged').catch(() => {});
		throw error;
	}
	let settledPeers = [];
	let activationBarrierPassed = false;
	try {
		const peerResults = [];
		const activateResponse = await server.replication.replicateOperation(
			buildPhaseOperation('activate', req.deployment_id, req.project, spec),
			{
				onPeerResult: (result) => {
					peerResults.push(result);
					emit('peer', result);
				},
			}
		);
		settledPeers = Array.isArray(activateResponse?.replicated) ? activateResponse.replicated : peerResults;
		await recordDeploymentPeers(req.deployment_id, settledPeers);
		emit('phase', { phase: 'activate', status: 'done' });
		const failed = failedPeerResults(settledPeers);
		if (failed.length && !req.ignore_replication_errors) {
			throw new ServerError(
				`Component '${req.project}' activated on only part of the cluster. Split nodes: ` +
					`${describePeerFailures(failed)}. Roll forward by staging and activating a known-good deployment.`
			);
		}
		activationBarrierPassed = failed.length === 0;
		if (!req.restart) markRestartRequiredForNewComponent(application);
		const restart = await restartActivatedComponent(req, req.deployment_id, req.project, spec, emit);
		if (restart.failedPeers.length) {
			settledPeers = [...settledPeers, ...restart.failedPeers];
			await recordDeploymentPeers(req.deployment_id, restart.failedPeers);
		}
		if (restart.failedPeers.length && !req.ignore_replication_errors) {
			throw new ServerError(
				`Component '${req.project}' activated, but restart failed on: ${describePeerFailures(restart.failedPeers)}`
			);
		}
		await markDeploymentTerminal(req.deployment_id, 'success');
		await maybeReclaimFinishedPayload(req.deployment_id, emit);
		await pruneProjectPayloads(req.project, getPayloadRetentionMaxCount()).catch((error) =>
			log.warn('Failed to prune activated deployment payloads', error)
		);
		return {
			message: `Activated component: ${req.project}${restart.restartMessage}`,
			project: req.project,
			activated: true,
			deployment_id: req.deployment_id,
			replicated: activateResponse?.replicated,
			...(restart.restartJobId ? { restartJobId: restart.restartJobId } : {}),
			...(failedPeerResults(settledPeers).length ? { failed_peers: failedPeerResults(settledPeers) } : {}),
		};
	} catch (error) {
		await markDeploymentTerminal(req.deployment_id, activationBarrierPassed ? 'success' : 'activating', error).catch(
			() => {}
		);
		throw error;
	}
}

async function componentDeployPhase(req) {
	if (!isTrustedReplicatedOperation(req)) {
		throw handleHDBError(new Error(), 'component_deploy_phase is restricted to authenticated cluster peers', 403);
	}
	const validation = validator.componentDeployPhaseValidator({
		phase: req.phase,
		deployment_id: req.deployment_id,
		project: req.project,
		activation_spec: req.activation_spec,
		deployment_timeout: req.deployment_timeout,
	});
	if (validation) throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	const spec = req.activation_spec;
	if (!spec || spec.project !== req.project) {
		throw handleHDBError(new Error(), 'Invalid immutable activation specification', HTTP_STATUS_CODES.BAD_REQUEST);
	}
	const componentPath = path.join(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), req.project);
	if (req.phase === 'discard') {
		await discardStagedApplication(componentPath, req.deployment_id);
		return { message: `Discarded staged component: ${req.project}` };
	}
	if (req.phase === 'restart') {
		const row = await getDeploymentRow(req.deployment_id);
		assertStoredActivationSpec(row, req.deployment_id, req.project, spec, [
			'pending',
			'staging',
			'staged',
			'activating',
		]);
		manageThreads.restartWorkers('http');
		return { message: `Restarting component runtime for: ${req.project}` };
	}
	if (req.phase === 'stage') {
		assertNotProtectedCoreComponent(req.project, spec.force);
		const timeoutMs = coerceTimeoutMs(req.deployment_timeout, DEFAULT_AWAIT_ROW_TIMEOUT_MS);
		const payload = await sourceStagedPayload(req.deployment_id, spec, timeoutMs);
		const credentials = await resolveSpecCredentials(spec, timeoutMs);
		const application = applicationFromSpec(spec, payload, credentials, createInstallCapture());
		const stagedPath = await stageApplication(application, req.deployment_id);
		await loadValidateComponent({ dirPath: stagedPath, emit: () => {} });
		return { message: `Staged component: ${req.project}`, project: req.project, staged: true };
	}
	const row = await getDeploymentRow(req.deployment_id);
	assertStoredActivationSpec(row, req.deployment_id, req.project, spec, ['pending', 'staging', 'staged', 'activating']);
	let application;
	const stagedPath = stagedApplicationPath(componentPath, req.deployment_id);
	if (await hasCompleteStagedApplication(stagedPath)) {
		application = applicationFromSpec(spec, undefined, undefined, null);
		await loadValidateComponent({ dirPath: stagedPath, emit: () => {} });
	} else {
		const timeoutMs = coerceTimeoutMs(req.deployment_timeout, DEFAULT_AWAIT_ROW_TIMEOUT_MS);
		const payload = await sourceStagedPayload(req.deployment_id, spec, timeoutMs);
		const credentials = await resolveSpecCredentials(spec, timeoutMs);
		application = applicationFromSpec(spec, payload, credentials, createInstallCapture());
		const rebuiltPath = await stageApplication(application, req.deployment_id);
		await loadValidateComponent({ dirPath: rebuiltPath, emit: () => {} });
	}
	const configTransaction = await createApplicationActivationTransaction(req.project, spec);
	await activateStagedApplication(application, req.deployment_id, {
		beforeSwap: async () => {
			await claimStagedDeployment(req.deployment_id, req.project, {
				allowActivating: true,
				waitForStagedMs: coerceTimeoutMs(req.deployment_timeout, DEFAULT_AWAIT_ROW_TIMEOUT_MS),
			});
		},
		beforeCommit: () => configTransaction.commit(),
		onRollback: () => configTransaction.rollback(),
	});
	markRestartRequiredForNewComponent(application);
	return { message: `Activated component: ${req.project}`, project: req.project, activated: true };
}

function isTrustedReplicatedOperation(req) {
	const user = req.hdb_user;
	return (
		isOperationAuthorizationBypassed() &&
		req.replicated === false &&
		!!user &&
		!!(user.name || user.replicates || user.subscribers)
	);
}

async function _revertComponent(req) {
	if (req.project) req.project = path.parse(req.project).name;
	const validation = validator.revertComponentValidator(req);
	if (validation) throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);

	const isReplicatedExecution = typeof req._deploymentId === 'string';
	const emitter = isReplicatedExecution ? null : (req.progress ?? new ProgressEmitter());
	if (emitter && !req.progress) req.progress = emitter;
	// The origin records a rollback row for observability; a peer replaying the revert does not.
	const recorder = isReplicatedExecution
		? null
		: await DeploymentRecorder.create({
				project: req.project,
				package_identifier: null,
				user: req.hdb_user?.username,
				restart_mode: req.restart === 'rolling' ? 'rolling' : req.restart ? 'immediate' : null,
				rollback_of: req.deployment_id ?? null,
				emitter,
			});
	if (recorder) req._deploymentId = recorder.deploymentId;
	const emit = (event, data) => emitter?.emit(event, data);
	const installCapture = createInstallCapture(); // revert has no install output, but finalizeDeployFailure expects one
	const rollingRestart = req.restart === 'rolling';

	try {
		const application = new Application({ name: req.project });
		emit('phase', { phase: 'revert', status: 'start' });
		await revertApplication(application);
		emit('phase', { phase: 'revert', status: 'done' });

		const response = { message: `Reverted component: ${req.project}`, project: req.project, reverted: true };
		if (recorder) response.deployment_id = recorder.deploymentId;

		// Replicate the revert to peers (direct invocation only; a peer replaying must not re-fan).
		req.restart = rollingRestart ? false : req.restart;
		if (!isReplicatedExecution) {
			delete req.progress;
			const revertOp = buildReplicatedSubOp(req, hdbTerms.OPERATIONS_ENUM.REVERT_COMPONENT, {
				restart: req.restart,
				deploymentId: recorder?.deploymentId,
			});
			recorder?.seal();
			const rep = await server.replication.replicateOperation(revertOp, {
				onPeerResult: recorder
					? (result) => {
							recorder.recordPeer(result);
							emit('peer', result);
						}
					: undefined,
			});
			if (recorder && rep?.replicated) recorder.recordPeers(rep.replicated);
		}

		// Restart on this node (peers replaying an immediate-restart revert restart locally; the rolling
		// path is driven only by the direct invoker via a replicated restart_service job).
		if (req.restart === true) {
			emit('phase', { phase: 'restart', status: 'start' });
			manageThreads.restartWorkers('http');
			emit('phase', { phase: 'restart', status: 'done' });
			response.message = `Reverted component: ${req.project}, restarting Harper`;
		} else if (rollingRestart && !isReplicatedExecution) {
			const serverUtilities = require('../server/serverHelpers/serverUtilities.ts');
			emit('phase', { phase: 'restart', status: 'start' });
			const jobResponse = await serverUtilities.executeJob({
				operation: 'restart_service',
				service: 'http',
				replicated: true,
			});
			emit('phase', { phase: 'restart', status: 'done' });
			response.restartJobId = jobResponse.job_id;
			response.message = `Reverted component: ${req.project}, restarting Harper`;
		}

		if (recorder && !req.ignore_replication_errors) {
			const failed = recorder.getFailedPeers();
			if (failed.length > 0) {
				throw new ServerError(
					`Component '${req.project}' was reverted on the origin but failed to revert on ${failed.length} ` +
						`of ${recorder.row.peer_results.length} peer node(s): ${describePeers(failed)}. ` +
						`See deployment ${recorder.deploymentId} (get_deployment), or pass ignore_replication_errors: true.`
				);
			}
		}

		if (recorder) {
			emit('phase', { phase: 'success', status: 'done' });
			await recorder.finish('rolled_back');
		}
		return response;
	} catch (err) {
		throw await finalizeDeployFailure({ err, recorder, installCapture, emit });
	}
}

// ————————————————————————————————————————————————————————————————————————————
// Shared deploy-family helpers (used by deploy_component, stage_component, activate_component).
// ————————————————————————————————————————————————————————————————————————————

// Reject deploying over a protected core component name unless force is set. Lazy-loads
// componentLoader to avoid a circular dependency.
function assertNotProtectedCoreComponent(project, force) {
	const { TRUSTED_RESOURCE_PLUGINS } = require('./componentLoader.ts');
	if (TRUSTED_RESOURCE_PLUGINS[project] && !force) {
		throw handleHDBError(
			new Error(),
			`Cannot deploy component with name '${project}': this is a protected core component name. Use force: true to overwrite.`,
			HTTP_STATUS_CODES.CONFLICT
		);
	}
}

// Persist a `package` deploy's entry into root config so every cold install (reboot, new peer,
// rollback) reinstalls it. In two-phase this runs at activation, once the bits are staged everywhere.
async function writeComponentRootConfig(req, credentialReferences) {
	assertNotProtectedCoreComponent(req.project, req.force);
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
	// Persist credential references (never tokens) so every cold install re-resolves from the store.
	if (credentialReferences.length) applicationConfig.credentials = credentialReferences;
	await configUtils.addConfig(req.project, applicationConfig);
}

// Resolve the tarball to extract from. On the origin, tee req.payload into the row's blob (the
// channel peers read from) and re-source extraction from the persisted blob. On a peer replaying a
// deploy without a payload, read the tarball from the replicated row's blob (bounded wait).
async function sourceExtractionPayload({ req, recorder, isReplicatedExecution }) {
	if (recorder && req.payload != null) {
		await recorder.ingestPayload(req.payload);
		return recorder.row.payload_blob.stream();
	}
	if (isReplicatedExecution && req.payload == null && !req.package) {
		// Blob.stream() blocks on in-flight BLOB_CHUNK writes until the chunks land. If the row never
		// arrives within the timeout, the peer records a failure and the origin sees it in peer_results.
		// The wait budget defaults to 120s but is overridable per-deploy via `deployment_timeout` (ms)
		// for clusters where the system-table channel is heavily backlogged (harper-pro#402).
		const payloadTimeoutMs = coerceTimeoutMs(req.deployment_timeout, DEFAULT_AWAIT_ROW_TIMEOUT_MS);
		// One deadline covers both phases (row wait + blob content) so a slow row doesn't double the
		// peer's worst-case wait — whatever's left after the row arrives is what the blob retry gets.
		const payloadDeadline = Date.now() + payloadTimeoutMs;
		const row = await awaitDeploymentRow(req._deploymentId, { timeoutMs: payloadTimeoutMs });
		// Blob content can stall independently of the row arriving (a parked/declined blob send on the
		// origin, harper-pro#403): the header lands but content bytes don't, and stream() gives up with a
		// retryable 503 after blobReadTimeout of no progress. Retry with backoff, bounded by the remaining
		// budget, so a transient stall doesn't fail the whole deploy (harper-pro incident, 2026-07-16).
		return readPayloadBlobWithRetry(() => row.payload_blob.stream(), {
			timeoutMs: Math.max(0, payloadDeadline - Date.now()),
		});
	}
	return req.payload;
}

// Resolve credential references into concrete tokens for this node's npm pack/install. On a peer, the
// referenced hdb_secret row may arrive just behind the deploy op, so allow a bounded grace period.
async function resolveNodeCredentials({ req, resolveCredentials, isReplicatedExecution }) {
	let credentialsWaitMs = 0;
	if (isReplicatedExecution) {
		// Same budget as the payload-row wait, via the shared coercion helper (harper#1838 dedup).
		credentialsWaitMs = coerceTimeoutMs(req.deployment_timeout, DEFAULT_AWAIT_ROW_TIMEOUT_MS);
	}
	return resolveCredentials(req.credentials, req.project, { waitMs: credentialsWaitMs });
}

// Construct the Application for a deploy, teeing each install line into the capture buffer (for the
// thrown-error tail) and the SSE channel (when a caller is streaming).
function buildDeployApplication({
	req,
	extractionPayload,
	resolvedCredentials,
	stagingId,
	installCapture,
	emitter,
	emit,
}) {
	return new Application({
		name: req.project,
		payload: extractionPayload,
		packageIdentifier: req.package,
		install: {
			command: req.install_command,
			timeout: req.install_timeout,
			allowInstallScripts: req.install_allow_scripts,
		},
		onInstallLine: (manager, stream, line) => {
			installCapture.push(manager, stream, line);
			if (emitter) emit('install', { manager, stream, line });
		},
		credentials: resolvedCredentials,
		stagingId,
	});
}

// Load a component directory to surface load-time errors early (throwaway scopes). No-op on the main
// thread or in safe mode. In two-phase this loads the STAGED directory before go-live; in one-shot it
// loads the live directory after in-place prepare.
async function loadValidateComponent({ dirPath, emit }) {
	if (isMainThread || process.env.HARPER_SAFE_MODE) return;
	const pseudoResources = new Resources();
	pseudoResources.isWorker = true;

	const componentLoader = require('./componentLoader.ts').default || require('./componentLoader.ts');
	const { trackScopeClose } = require('./scopeShutdown.ts');
	let lastError;
	componentLoader.setErrorReporter((error) => (lastError = error));
	emit('phase', { phase: 'load', status: 'start' });
	// The Scopes this load creates are throwaway. Collect them (instead of registering for
	// worker-shutdown auto-close) so we can close them here once validation completes — otherwise each
	// deploy leaks the Scope's deploy-lifecycle listeners on this worker (#1462).
	const validationScopes = new Set();
	// Process-wide `server.*` registrations (registerOperation, setMcpQuotaHandler) are not owned by
	// a Scope, so a candidate's top-level registration during this throwaway load would otherwise
	// outlive it and pollute the live worker on a failed/rolled-back deploy. The guard makes those
	// registration methods no-op for the duration of the load.
	const { runWithDeployValidationGuard } = require('../server/serverHelpers/deployValidationState.ts');
	const validation = runWithDeployValidationGuard(async () => {
		try {
			await componentLoader.loadComponent(dirPath, pseudoResources, undefined, { collectScopes: validationScopes });
		} finally {
			const closeResults = await Promise.allSettled(Array.from(validationScopes, (scope) => scope.close()));
			for (const result of closeResults) {
				if (result.status === 'rejected') log.warn('Failed to close a deploy-validation Scope', result.reason);
			}
		}
	});
	// Track the load+close so a concurrent worker shutdown waits for these scopes to finish disposing.
	trackScopeClose(validation);
	await validation;
	emit('phase', { phase: 'load', status: 'done' });
	if (lastError) throw lastError;
}

// Build a replicated sub-operation body for the peer fan-out. For the two-phase peer phases this is
// `deploy_component` tagged with an internal `_phase` marker (`stage`/`activate`) — the wire format —
// so no separate public op is exposed; revert uses operation `revert_component`. Carries only what a
// peer needs: project, the deployment id (correlation + payload lookup + staging id), the internal
// `_phase`, the build/config inputs, and credential REFERENCES (tokens are already stripped).
function buildReplicatedSubOp(req, operation, { includePayload = false, restart, deploymentId, phase } = {}) {
	const op = { operation, project: req.project, _deploymentId: deploymentId ?? req._deploymentId };
	if (phase) op._phase = phase;
	if (req.package) op.package = req.package;
	if (req.install_command != null) op.install_command = req.install_command;
	if (req.install_timeout != null) op.install_timeout = req.install_timeout;
	if (req.install_allow_scripts !== undefined) op.install_allow_scripts = req.install_allow_scripts;
	if (req.deployment_timeout != null) op.deployment_timeout = req.deployment_timeout;
	if (req.urlPath !== undefined) op.urlPath = req.urlPath;
	if (req.force !== undefined) op.force = req.force;
	if (req.ignore_replication_errors !== undefined) op.ignore_replication_errors = req.ignore_replication_errors;
	if (Array.isArray(req.credentials) && req.credentials.length) op.credentials = req.credentials;
	if (includePayload && req.payload != null) op.payload = req.payload;
	if (restart !== undefined) op.restart = restart;
	return op;
}

// Render failed peer outcomes as "node (error)" for an operator-facing error message.
function describePeers(failedPeers) {
	return failedPeers.map((peer) => `${peer.node ?? 'unknown'} (${peer.error?.message ?? 'unknown error'})`).join(', ');
}

/**
 * Collect per-peer replication outcomes when there is no DeploymentRecorder to hold them — the
 * activate-existing path, where the hdb_deployment row was already created (and finished as `staged`)
 * by the earlier stage-and-stop. Mirrors DeploymentRecorder.recordPeer's semantics exactly: results are
 * normalized by the same normalizePeerResult and upserted by node name, so a peer reported both through
 * the streaming `onPeerResult` callback and again in replicateOperation's final `replicated` aggregate
 * is counted once, not twice.
 */
function createPeerResultCollector() {
	const list = [];
	const record = (result) => {
		const normalized = normalizePeerResult(result);
		const nodeName = normalized.node;
		const idx = nodeName ? list.findIndex((entry) => entry.node === nodeName) : -1;
		if (idx >= 0) list[idx] = normalized;
		else list.push(normalized);
	};
	return {
		record,
		recordAll(results) {
			if (Array.isArray(results)) for (const result of results) record(result);
		},
		getFailed: () => list.filter((peer) => peer?.status === 'failed'),
		get total() {
			return list.length;
		},
	};
}

/**
 * Shared post-activate failure gate for every cluster-wide activate (the two-phase deploy's activate
 * phase and `deploy_component({ deployment_id })`). replicateOperation never rejects on a per-peer
 * failure — failures surface only as 'failed' peer entries — so without this gate a partially-failed
 * activate returns 2xx and silently leaves the cluster split across versions.
 *
 * Unless `ignore_replication_errors` is set, throws when any peer failed to activate. When
 * `revert_on_failure` is set, first rolls the origin and the peers that DID activate back to the
 * retained previous version so the cluster reconverges — best-effort, since a revert failure must not
 * mask the original activate failure.
 */
async function enforceActivatePeerGate({ req, application, emit, failed, totalPeers, deploymentId }) {
	if (req.ignore_replication_errors) return;
	if (!failed || failed.length === 0) return;
	let revertNote = '';
	if (req.revert_on_failure) {
		try {
			emit('phase', { phase: 'revert', status: 'start' });
			// The origin activated, so revert it.
			await revertApplication(application);
			// With `restart: true` the origin's workers already reloaded onto the new (failed-cluster)
			// version — the origin restart runs before this gate — so the directory rollback above is not
			// picked up on its own. The peers' revert op carries `restart`, so they DO come back on the
			// previous version; without this the origin would be the one node left serving the new version,
			// the exact opposite of the reconvergence revert_on_failure exists to provide. A rolling restart
			// arrives here with `restart` already normalized to false and its peers likewise un-restarted,
			// so origin and peers stay consistent in that case without a second restart.
			if (req.restart === true) manageThreads.restartWorkers('http');
			// Revert ONLY the peers that successfully activated (see selectRevertTargets): every known
			// node minus the ones that failed to activate (still on the correct version) and minus this
			// node (already reverted directly above; a second bidirectional revert would flip it back).
			// replicateOperation has no subset targeting, so send point-to-point via sendOperationToNode.
			const { getThisNodeName } = require('../server/nodeName.ts');
			const activatedPeers = selectRevertTargets(server.nodes, failed, getThisNodeName());
			const revertOp = buildReplicatedSubOp(req, hdbTerms.OPERATIONS_ENUM.REVERT_COMPONENT, {
				restart: req.restart,
				deploymentId,
			});
			revertOp.replicated = false; // point-to-point; the peer must not re-fan the revert
			const revertResults = await Promise.allSettled(
				activatedPeers.map((node) => server.replication.sendOperationToNode(node, revertOp))
			);
			const revertFailures = revertResults.filter((result) => result.status === 'rejected').length;
			emit('phase', { phase: 'revert', status: 'done' });
			revertNote =
				` Rolled the origin and ${activatedPeers.length - revertFailures} of ${activatedPeers.length} ` +
				`activated peer(s) back to the previous version (revert_on_failure); the ${failed.length} peer(s) ` +
				`that never activated were left on their current (correct) version.` +
				(revertFailures > 0 ? ` ${revertFailures} peer revert(s) also failed.` : '') +
				` Verify with get_components.`;
		} catch (revertErr) {
			log.warn('revert_on_failure rollback failed', revertErr);
			revertNote = ` An automatic rollback (revert_on_failure) was attempted but also failed: ${revertErr?.message ?? revertErr}.`;
		}
	}
	throw new ServerError(
		`Component '${application.name}' was activated on the origin but failed to activate on ${failed.length} ` +
			`of ${totalPeers} peer node(s): ${describePeers(failed)}. Those nodes have the staged ` +
			`build but did not go live.${revertNote} See deployment ${deploymentId} (get_deployment), or pass ` +
			`ignore_replication_errors: true.`
	);
}

// Choose which peers a revert_on_failure swap-back should target: every known node EXCEPT
//   - `thisNodeName`: the origin, already reverted directly by the caller — a second (bidirectional)
//     revert would flip it back to the just-activated version; and
//   - any node in `failedPeers`: it never activated (its failure fired before activateApplication ran
//     retainAsPrevious), so its live directory is still the correct pre-deploy version and reverting it
//     would roll it back an EXTRA version onto a two-deploys-ago copy.
// Pure and exported so the node-targeting logic (which had two review-caught bugs — the failed-peer
// skip and the self-skip) is unit-testable without a live cluster. `nodes` is `server.nodes`, which
// normally already excludes self, but a not-yet-named node can slip in (knownNodes) so self is guarded
// here regardless — matching every other point-to-point fan-out in the code base (bin/restart.ts).
function selectRevertTargets(nodes, failedPeers, thisNodeName) {
	const failedNodeNames = new Set((failedPeers ?? []).map((peer) => peer.node).filter(Boolean));
	return (nodes ?? []).filter((node) => node?.name !== thisNodeName && !failedNodeNames.has(node?.name));
}

// Reclaim the payload tarball for large deploys once every peer has installed from the blob. Dropping
// the reference before finish() folds the null into the single terminal write, which unlinks the file
// locally and replicates the null so peers drop their copies too. Metadata is retained. Kept when a
// peer failed (still the retry artifact) or the payload is small.
function maybeReclaimPayload(recorder, emit) {
	const payloadSize = recorder.row.payload_size;
	const retentionMaxSize = getPayloadRetentionMaxSize();
	if (typeof payloadSize === 'number' && payloadSize > retentionMaxSize && recorder.getFailedPeers().length === 0) {
		const freed = recorder.dropPayload();
		if (freed > 0) emit('payload_dropped', { payload_size: freed, max_size: retentionMaxSize });
	}
}

async function maybeReclaimFinishedPayload(deploymentId, emit) {
	try {
		const row = await getDeploymentRow(deploymentId);
		const payloadSize = row?.payload_size;
		const retentionMaxSize = getPayloadRetentionMaxSize();
		if (
			typeof payloadSize !== 'number' ||
			payloadSize <= retentionMaxSize ||
			failedPeerResults(row.peer_results).length > 0 ||
			row.payload_blob == null
		) {
			return;
		}
		const { handleDeleteDeploymentPayload } = require('./deploymentOperations.ts');
		const result = await handleDeleteDeploymentPayload({ deployment_id: deploymentId });
		if (result.freed_bytes > 0) {
			emit('payload_dropped', { payload_size: result.freed_bytes, max_size: retentionMaxSize });
		}
	} catch (error) {
		log.warn(`Failed to reclaim payload for activated deployment '${deploymentId}'`, error);
	}
}

/**
 * Count-based payload retention (deployment_payloadRetention_maxCount): after a successful deploy, keep
 * only the newest N stored payloads for this project and drop the rest. Where the size-based reclaim
 * above only ever considers THIS deploy's payload, this bounds the total that accumulates per project.
 *
 * Deliberately best-effort and never awaited into the deploy's critical path: retention is disk
 * hygiene, so a prune failure is logged and the deploy still succeeds. Skipped when a peer failed —
 * the older payloads are still the retry/rollback artifacts in that case.
 */
function schedulePayloadRetentionPrune(recorder, project, emit) {
	if (recorder.getFailedPeers().length > 0) return;
	const maxCount = getPayloadRetentionMaxCount();
	pruneProjectPayloads(project, maxCount)
		.then((freed) => {
			if (freed > 0) emit('payload_dropped', { payload_size: freed, max_count: maxCount });
		})
		.catch((err) => log.warn(`Failed to prune retained deployment payloads for '${project}'`, err));
}

// Build the structured failure (phase, install-output tail, deployment_id, failed peers) that the
// Fastify error handler forwards verbatim, emit the matching SSE 'error' event so the two transports
// stay symmetric, and record the terminal failure row. Returns the ServerError to throw.
async function finalizeDeployFailure({ err, recorder, installCapture, emit }) {
	const capture = installCapture.snapshot();
	const phase = recorder?.row.phase;
	const baseMessage = err?.message ?? String(err);
	const structured = { error: baseMessage };
	if (phase) structured.phase = phase;
	if (capture.lines.length > 0) structured.install_output = capture;
	if (recorder?.deploymentId) structured.deployment_id = recorder.deploymentId;
	const failedPeers = recorder?.getFailedPeers() ?? [];
	if (failedPeers.length > 0) structured.failed_peers = failedPeers;

	// Wrap as a ServerError so the Fastify error handler picks a 500 by default; preserve an upstream
	// statusCode (e.g. a ClientError from payload validation) if present.
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
	// Record the terminal failure, but never let a finish() write error mask the actual deploy failure.
	if (recorder) {
		try {
			await recorder.finish('failed', err);
		} catch (finishErr) {
			log.warn('Failed to record deployment failure row', finishErr);
		}
	}
	return outErr;
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
				if (
					itemName === 'node_modules' ||
					itemName === ASIDE_STAGING_DIR ||
					itemName === DEPLOY_STAGING_DIR ||
					itemName === DEPLOY_ACTIVATION_DIR ||
					itemName === DEPLOY_PREVIOUS_DIR ||
					itemName === COMPONENT_PREPARATION_LOCK_DIR
				)
					continue;
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

// How many stored payload tarballs to keep per project (newest first); older ones have their
// payload_blob dropped after a successful deploy. Default 1 — retain only the current version's
// payload. Conservative on purpose: instances on small quotas (free tier is 5GB total) must not have
// N copies of a large app payload quietly competing with the customer's own data. Raise it to widen
// the redeploy-by-reference window; 0 retains none. Configurable via
// deployment_payloadRetention_maxCount.
const DEFAULT_PAYLOAD_RETENTION_MAX_COUNT = 1;

function getPayloadRetentionMaxCount() {
	const configured = configUtils.getConfigValue(hdbTerms.CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXCOUNT);
	// Same input discipline as getPayloadRetentionMaxSize: only a number or numeric string is a valid
	// count. Anything else (unset, boolean, array, blank string) would coerce to 0 or 1 and silently
	// change retention, so fall back to the default instead.
	if (typeof configured !== 'number' && typeof configured !== 'string') return DEFAULT_PAYLOAD_RETENTION_MAX_COUNT;
	if (typeof configured === 'string' && configured.trim() === '') return DEFAULT_PAYLOAD_RETENTION_MAX_COUNT;
	const parsed = Number(configured);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PAYLOAD_RETENTION_MAX_COUNT;
	return Math.floor(parsed);
}

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
	const componentsRoot = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const componentPath = path.join(componentsRoot, project);
	const pathToComponent = path.join(componentsRoot, projectPath);

	await withComponentPreparationLock(componentPath, async () => {
		const componentSymlink = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project);
		if (await fs.pathExists(componentSymlink)) {
			await fs.unlink(componentSymlink);
		}

		if (!file) {
			await invalidateProjectStagedDeployments(project);
			await discardProjectStagedApplications(componentPath);
			await discardProjectActivationArtifacts(componentPath);
		}
		if (await fs.pathExists(pathToComponent)) await fs.remove(pathToComponent);
		if (!file) await updateApplicationLockEntry(project, undefined);

		const packageJsonPath = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'package.json');
		if (await fs.pathExists(packageJsonPath)) {
			const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
			if (packageJson?.dependencies?.[project]) delete packageJson.dependencies[project];
			await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
		}

		configUtils.deleteConfigFromFile([project]);
	});

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
exports.componentDeployPhase = componentDeployPhase;
exports.getComponents = getComponents;
exports.getComponentFile = getComponentFile;
exports.setComponentFile = setComponentFile;
exports.getEnvKeys = getEnvKeys;
exports.setEnvValue = setEnvValue;
exports.deleteEnvValue = deleteEnvValue;
exports.dropComponent = dropComponent;
