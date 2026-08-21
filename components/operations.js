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
	revertApplication,
	stagedApplicationPath,
	hasCompleteStagedApplication,
	activateStagedApplication,
	discardStagedApplication,
	discardProjectStagedApplications,
	discardProjectActivationArtifacts,
	updateApplicationLockEntry,
	withPersistentStateLock,
	createApplicationActivationTransaction,
	createApplicationConfigTransaction,
	getRevertTarget,
	getStagingRetentionMaxCount,
	dropComponentDirectory,
	discardRetainedPrevious,
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

const DROP_COMPONENT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function componentDropLockOptions(project) {
	return {
		timeoutMs: DROP_COMPONENT_LOCK_TIMEOUT_MS,
		onWait: (owner) =>
			log.info(
				`Waiting to drop ${project} while component preparation is in progress` +
					(owner ? ` in process ${owner.pid}, thread ${owner.threadId}` : '')
			),
		onReleaseError: (error) => log.error(`Failed to release the component preparation lock for ${project}:`, error),
		isOwnerAlive: (owner) => owner.pid !== process.pid || manageThreads.isThreadRunning(owner.threadId),
	};
}

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
	const { project, install_command, install_timeout, install_allow_scripts } = req;

	const template = req.template || 'https://github.com/harperdb/application-template';

	try {
		await fs.mkdir(configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT), { recursive: true });
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
		const stagingDir = path.join(cfDir, ASIDE_STAGING_DIR, project);
		// Nothing live AND nothing parked aside means there is genuinely no such component: let stat throw
		// the ENOENT so the caller gets "no such project" rather than a silent success.
		if (!(await fs.pathExists(projectDir)) && !(await fs.pathExists(stagingDir))) await fs.stat(projectDir);
		// Invalidate staged deployments BEFORE the directory goes away, so an activate racing this drop
		// cannot swap a staged build back into a project that is being deleted.

		await withComponentPreparationLock(
			projectDir,
			async () => {
				// Retires any interrupted-extraction aside for this component and renames the live directory
				// aside before removing it, so a concurrent startup recovery can never restore a tree over a
				// component that was just dropped.
				// Inside the lock: an invalidation done before acquiring it leaves a window where a
				// concurrent stage completes and is then activated over the just-dropped component.
				await invalidateProjectStagedDeployments(project);
				await discardProjectStagedApplications(projectDir);
				await discardProjectActivationArtifacts(projectDir);
				await discardRetainedPrevious(projectDir);
				await dropComponentDirectory(projectDir, project, log);
			},
			componentDropLockOptions(project)
		);
		await updateApplicationLockEntry(project, undefined);
		const response = await server.replication.replicateOperation(req);
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
 * `two_phase: false` forces the one-shot path. See DESIGN.md for the stage/activate protocol.
 *
 * @param req
 * @returns {Promise<object>}
 */
async function deployComponent(req) {
	normalizeRequestBooleans(req);
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
 * Mark a restart as needed when this deploy changed code the running process can't pick up on its own.
 * Setter only — it does not restart; it makes get_status report restartRequired:true and lets the REST
 * route-miss path surface the actionable "needs a restart" 404 (harper#674).
 *
 * Two triggers:
 *   - `isNewComponent`: a genuinely-new, never-loaded component can't serve its routes until Harper
 *     restarts. Scoped to new components (harper#1806) because an existing component's own file watcher
 *     independently requests a restart when a redeploy actually needs one, so a redeploy stays quiet.
 *   - `packageMetadataChanged`: installed package metadata sits outside most plugin watch globs, so no
 *     watcher sees a dependency or module-entry change — but it does invalidate already-loaded code.
 *     Compared across the swap by the deploy path that performed it.
 *
 * Runs per node: each node checks its own directory state, which can differ across the cluster (a
 * component can be new on a peer that never had it and a redeploy on the origin). The one-shot path has
 * extractApplication/prepareApplication set both flags in place; the two-phase path has
 * activateStagedApplication set them at swap time, comparing the pre-swap live tree against the staged
 * one (staging is always fresh, so extraction never sees the live dir).
 */
function markRestartRequiredForDeploy(application) {
	if (application.isNewComponent || application.packageMetadataChanged) {
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
			// An existing, already-active component being redeployed does NOT force a restart here: some
			// updates (e.g. static files only) may not need one at all, and when one genuinely is needed,
			// that component's already-running file watcher (Scope/EntryHandler, see deployLifecycle.ts)
			// independently detects the post-deploy file changes and requests the restart itself. Package
			// metadata is the exception the helper handles — it sits outside most plugin globs, so no
			// watcher sees a dependency or module-entry change.
			markRestartRequiredForDeploy(application);
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

// Every boolean in the deploy_component/revert_component schemas. Joi coerces a string `"false"`, but
// validateBySchema discards `result.value`, so the raw string reaches the handler and reads as truthy.
// `install_allow_scripts` is the one that matters most: a caller explicitly disabling lifecycle scripts
// over multipart/form would otherwise run third-party install code with credentials available.
const REQUEST_BOOLEAN_FIELDS = [
	'activate',
	'two_phase',
	'ignore_replication_errors',
	'force',
	'restart',
	'install_allow_scripts',
];

function normalizeRequestBooleans(req) {
	for (const field of REQUEST_BOOLEAN_FIELDS) {
		const value = req[field];
		if (typeof value !== 'string') continue;
		const lowered = value.trim().toLowerCase();
		if (lowered === 'true') req[field] = true;
		else if (lowered === 'false') req[field] = false;
	}
}

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

async function pruneStagedDeploymentArtifacts(project, activationSpec, keepDeploymentId) {
	const expired = await expireOldStagedDeployments(project, getStagingRetentionMaxCount(), keepDeploymentId);
	for (const deploymentId of expired) await discardDeploymentEverywhere(project, deploymentId, activationSpec);
}

async function restartActivatedComponent(req, deploymentId, project, activationSpec, emit) {
	if (req.restart === true) {
		emit('phase', { phase: 'restart', status: 'start' });
		const restartResponse = await server.replication.replicateOperation(
			buildPhaseOperation('restart', deploymentId, project, activationSpec, {
				deployment_timeout: req.deployment_timeout,
			})
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
			await pruneStagedDeploymentArtifacts(req.project, activationSpec, recorder.deploymentId).catch((error) =>
				log.warn('Failed to prune expired staged deployments', error)
			);
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
			activationSpec,
		});
		activationCommitted = true;
		const activateResponse = await server.replication.replicateOperation(
			buildPhaseOperation('activate', recorder.deploymentId, req.project, activationSpec, {
				deployment_timeout: req.deployment_timeout,
			}),
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
		if (!req.restart) markRestartRequiredForDeploy(application);
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
			activationSpec: spec,
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
			buildPhaseOperation('activate', req.deployment_id, req.project, spec, {
				deployment_timeout: req.deployment_timeout,
			}),
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
		if (!req.restart) markRestartRequiredForDeploy(application);
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
		activationSpec: spec,
	});
	markRestartRequiredForDeploy(application);
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

/**
 * revert_component — put a component's retained previous version back in service, cluster-wide.
 *
 * This is the fast-rollback half of the deploy story, and it is deliberately a separate public
 * operation rather than a deploy phase: it fetches nothing, resolves no package or secret, downloads
 * no artifact and runs no install. The bytes it activates are already on disk on every node — the tree
 * each node's last activation displaced and retained as `.deploy-previous/<name>` — so the whole
 * cluster can go back to the version it was serving a minute ago at the cost of one atomic rename per
 * node. It exists for the case operators actually hit: the one bad rollout that just happened.
 *
 * It is NOT a general "go to any past version" operation. Exactly one previous version is retained per
 * component, so this reaches back exactly one activation. Returning to an older version is a redeploy
 * (`deploy_component`), not a revert.
 *
 * `to_deployment_id` is required and names the deployment the caller expects to be live afterwards,
 * which is what makes the operation idempotent under ordinary request retries: if
 * that version is already live the call succeeds without touching anything, instead of toggling the
 * rejected release back in. Targeting the retained previous swaps, and the displaced tree becomes the
 * new retained previous — so an explicitly-targeted revert-of-a-revert still rolls forward.
 *
 * The swap is paired with persistent state. `revertApplication` reports the root-config entry the
 * newly-live tree was originally activated with, and this applies it to both the root config and the
 * boot-time install lock. Without that, reverting away from a `package` deploy would leave the config
 * still naming the reverted-away package, and `installApplications()` would quietly reinstall it over
 * the restored directory on the next cold start — undoing the rollback.
 */
async function revertComponent(req) {
	normalizeRequestBooleans(req);
	if (req.project) req.project = path.parse(req.project).name;
	const validation = validator.revertComponentValidator(req);
	if (validation) throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
	assertNotProtectedCoreComponent(req.project, req.force);

	const isReplicatedExecution = isTrustedReplicatedOperation(req);
	const emitter = isReplicatedExecution ? null : (req.progress ?? new ProgressEmitter());
	const emit = emitter ? (event, data) => emitter.emit(event, data) : () => {};
	delete req.progress;

	const application = new Application({ name: req.project });
	// Read the retained-previous state before anything is created or moved: it supplies the deployment
	// this rollback takes out of service (recorded as `rollback_of`, which the recorder can only accept
	// at create time), and it lets an unrevertable request fail before a deployment row exists.
	const componentsRoot = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
	const revertTarget = await getRevertTarget(path.join(componentsRoot, req.project));
	// The origin records an auditable rollback row; a peer replaying the revert does not (the origin
	// owns the row, exactly as in the deploy fan-out).
	const recorder = isReplicatedExecution
		? null
		: await DeploymentRecorder.create({
				project: req.project,
				user: req.hdb_user?.username,
				restart_mode: req.restart === 'rolling' ? 'rolling' : req.restart ? 'immediate' : null,
				rollback_of: revertTarget?.live?.deployment_id ?? null,
				emitter,
			});
	try {
		emit('phase', { phase: 'revert', status: 'start' });
		// The config transaction commits inside revertApplication's component lock, between the directory
		// swap and the manifest write, so the directory, the manifest and root config/application-lock
		// share one fence. Committing it out here — after the lock released — let a queued activation swap
		// and commit in the gap, leaving that activation's bytes live under this revert's config.
		// revertApplication compensates the swap if this throws; rolling the partial config write back is
		// this transaction's job, since commit() makes two persistent writes and the first can land alone.
		let configTransaction;
		const result = await revertApplication(application, req.to_deployment_id, {
			commitPersistentState: async (activatedConfig) => {
				configTransaction = await createApplicationConfigTransaction(req.project, activatedConfig);
				await configTransaction.commit();
			},
			// Called for any failure after the commit landed, not just a failing commit: the manifest write
			// and the retain rename come after it, and undoing only the directories would leave root config
			// and the application lock naming the release that is no longer live.
			rollbackPersistentState: async () => {
				await configTransaction?.rollback();
			},
		});
		emit('phase', { phase: 'revert', status: 'done' });

		// Fan out to peers. The operation is idempotent and target-addressed, so a peer that already
		// holds the target live converges to the same place without swapping — which is what makes a
		// straight re-run of the same operation the right replication primitive here.
		let replication;
		if (req.replicated !== false && !isReplicatedExecution) {
			replication = await server.replication.replicateOperation(
				{
					operation: hdbTerms.OPERATIONS_ENUM.REVERT_COMPONENT,
					project: req.project,
					to_deployment_id: req.to_deployment_id,
					restart: req.restart === true,
					...(req.force ? { force: req.force } : {}),
					...(req.deployment_timeout !== undefined ? { deployment_timeout: req.deployment_timeout } : {}),
				},
				{
					onPeerResult: (peerResult) => {
						recorder?.recordPeer(peerResult);
						emit('peer', peerResult);
					},
				}
			);
			if (replication?.replicated) recorder?.recordPeers(replication.replicated);
			const failed = recorder?.getFailedPeers() ?? [];
			if (failed.length && !req.ignore_replication_errors) {
				throw new ServerError(
					`Component '${req.project}' reverted on this node but failed on ${failed.length} peer node(s): ` +
						`${describePeerFailures(failed)}. The cluster is split across versions; retry the revert (it is a ` +
						`no-op on the nodes that already reverted) or roll forward with deploy_component.`
				);
			}
		}

		const restart = await restartRevertedComponent(req, emit);
		emit('phase', { phase: 'success', status: 'done' });
		await recorder?.finish('rolled_back');
		return {
			message: result.swapped
				? `Reverted component: ${req.project} to deployment ${req.to_deployment_id}${restart.restartMessage}`
				: `Component ${req.project} is already running deployment ${req.to_deployment_id}; nothing to revert`,
			project: req.project,
			reverted: result.swapped,
			to_deployment_id: req.to_deployment_id,
			...(result.fromDeploymentId ? { from_deployment_id: result.fromDeploymentId } : {}),
			...(recorder ? { deployment_id: recorder.deploymentId } : {}),
			...(replication?.replicated ? { replicated: replication.replicated } : {}),
			...(restart.restartJobId ? { restartJobId: restart.restartJobId } : {}),
		};
	} catch (error) {
		const message = error?.message ?? String(error);
		emit('error', { message, code: error?.statusCode ?? error?.code });
		await recorder
			?.finish('failed', error)
			.catch((finishError) => log.warn('Failed to record component revert failure', finishError));
		throw new ServerError(message, error?.statusCode);
	}
}

/** Restart after a revert, mirroring the deploy path's restart handling. */
async function restartRevertedComponent(req, emit) {
	if (req.restart === true) {
		emit('phase', { phase: 'restart', status: 'start' });
		manageThreads.restartWorkers('http');
		emit('phase', { phase: 'restart', status: 'done' });
		return { restartMessage: ', restarting Harper' };
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
		return { restartMessage: ', restarting Harper', restartJobId: jobResponse.job_id };
	}
	return { restartMessage: '' };
}

// Shared deploy-family helpers (used by deploy_component, its component_deploy_phase fan-out, and
// revert_component).

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
	if (req.host !== undefined) applicationConfig.host = req.host;
	// Persist credential references (never tokens) so every cold install of this component — reboot, new
	// peer, revert — re-resolves the credential from the store.
	if (credentialReferences.length) applicationConfig.credentials = credentialReferences;
	// Same critical section the activation transaction uses. `addConfig` is a read-modify-write of a
	// file whose entries are per-project, so a one-shot deploy running unlocked can write back a
	// document it parsed before a concurrent activation or drop committed, resurrecting or dropping
	// that project's entry.
	await withPersistentStateLock(() => configUtils.addConfig(req.project, applicationConfig));
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

// Render failed peer outcomes as "node (error)" for an operator-facing error message.
function describePeers(failedPeers) {
	return failedPeers.map((peer) => `${peer.node ?? 'unknown'} (${peer.error?.message ?? 'unknown error'})`).join(', ');
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

	await withComponentPreparationLock(
		componentPath,
		async () => {
			const componentSymlink = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'node_modules', project);
			if (await fs.pathExists(componentSymlink)) {
				await fs.unlink(componentSymlink);
			}

			if (!file) {
				// Invalidate staged deployments before the directory goes away, so an activate racing this
				// drop cannot swap a staged build back into a component that is being dropped.
				await invalidateProjectStagedDeployments(project);
				await discardProjectStagedApplications(componentPath);
				await discardProjectActivationArtifacts(componentPath);
				await discardRetainedPrevious(componentPath);
				// Retires any interrupted-extraction aside and renames the live tree aside before removing
				// it, so startup recovery can never restore a tree over a dropped component.
				await dropComponentDirectory(componentPath, project, log);
			} else if (await fs.pathExists(pathToComponent)) {
				await fs.remove(pathToComponent);
			}

			const packageJsonPath = path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), 'package.json');
			if (await fs.pathExists(packageJsonPath)) {
				const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
				if (packageJson?.dependencies?.[project]) {
					delete packageJson.dependencies[project];
				}
				await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
			}

			if (file) {
				// Under the persistent-state lock: an unlocked delete can be clobbered by a concurrent
				// activation writing back a document that still contains this project.
				await withPersistentStateLock(async () => configUtils.deleteConfigFromFile([project]));
			} else {
				// Both persistent writes as ONE reversible step, config first. Removing the application-lock
				// entry and the root-config entry separately meant a crash or a failed second write left root
				// config still naming the package with the live directory already gone — and the next boot's
				// installApplications() reinstalled the very component that was dropped.
				const dropTransaction = await createApplicationConfigTransaction(project, null);
				await dropTransaction.commit();
			}
		},
		componentDropLockOptions(project)
	);
	const response = await server.replication.replicateOperation(req);
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
exports.revertComponent = revertComponent;
exports.getComponents = getComponents;
exports.getComponentFile = getComponentFile;
exports.setComponentFile = setComponentFile;
exports.getEnvKeys = getEnvKeys;
exports.setEnvValue = setEnvValue;
exports.deleteEnvValue = deleteEnvValue;
exports.dropComponent = dropComponent;
