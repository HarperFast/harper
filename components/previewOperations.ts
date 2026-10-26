import Joi from 'joi';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { databases } from '../resources/databases.ts';
import { getConfigPath } from '../config/configUtils.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { ClientError, ServerError, hdbErrors } from '../utility/errors/hdbError.ts';
import { validateBySchema } from '../validation/validationWrapper.ts';
import { PROJECT_NAME_PATTERN } from '../utility/componentNames.ts';
import {
	CI_PREVIEW_CLEANUP_OPERATIONS,
	CI_PREVIEW_OPERATIONS,
	DEFAULT_PREVIEW_MAX_TTL_DAYS,
	GITHUB_ACTIONS_ISSUER,
	PREVIEW_CLEANUP_ENVIRONMENT,
	PREVIEW_ENVIRONMENT,
	PREVIEW_WORKFLOW,
	buildWorkflowRef,
	canonicalWorkflowPath,
	defaultPreviewDomain,
	derivePreviewNames,
	isPreviewProjectOf,
	type PreviewNames,
} from '../utility/previewIdentity.ts';
import {
	planIdentityReconcile,
	policiesOverlap,
	policyDifferences,
	type DesiredIdentity,
	type DesiredPolicy,
} from '../security/ciIdentity.ts';
import { componentGrantError, type ComponentGrant } from '../security/componentGrant.ts';
import { addRole, dropRole, getRoleByName, listRoles } from '../security/role.ts';
import { addUser, alterUser, dropUser, getUserWithRole, listUsersExternal } from '../security/user.ts';
import {
	addOidcTrust,
	assertTrustPolicyWritable,
	dropOidcTrust,
	listOidcTrust,
} from '../security/authn/oidc/trustPolicyOperations.ts';
import { listLocalPreviews } from './previews.ts';
import { withComponentPreparationLock } from './componentPreparationLock.ts';
import { dropComponent } from './operations.ts';
import { deploymentRecord } from './deploymentOperations.ts';
import { handleListReleases } from './releaseOperations.ts';
import { REPLICATION_NOT_IMPLEMENTED, server } from '../server/Server.ts';
import { getThisNodeName } from '../server/nodeName.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
const ENDED_DEPLOYMENT_STATUSES = new Set(['success', 'partial', 'failed', 'rolled_back', 'staged']);
const PEER_DROP_TIMEOUT_MS = 5 * 60 * 1000;
const CENSUS_TIMEOUT_MS = 60 * 1000;

function requireSuperUser(req: any): void {
	if (!req?.hdb_user?.role?.permission?.super_user) {
		throw new ClientError(
			`Operation '${req?.operation}' is restricted to super_user roles`,
			HTTP_STATUS_CODES.FORBIDDEN
		);
	}
}

function validate(validation: any): void {
	if (validation) throw new ClientError(validation.message);
}

function asClientError<T>(derive: () => T): T {
	try {
		return derive();
	} catch (error) {
		throw new ClientError((error as Error).message);
	}
}

const APP = Joi.string().pattern(PROJECT_NAME_PATTERN).max(200).required();

function previewNamesOf(req: any): PreviewNames {
	validate(validateBySchema(req, Joi.object({ app: APP }).unknown(true)));
	return asClientError(() => derivePreviewNames(req.app));
}

/**
 * One enable or disable at a time on this node, of any application: two applications sharing a workflow file would
 * otherwise both pass the overlap check. A writer on another node is not excluded.
 */
function withPreviewEnablementLock<T>(app: string, run: () => Promise<T>): Promise<T> {
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT) as string;
	return withComponentPreparationLock(join(componentsRoot, '.preview-enablement'), run, {
		purpose: `enabling or disabling previews of ${app}`,
	});
}

function previewPolicies(names: PreviewNames, policies: any[]): any[] {
	return policies.filter((policy) => policy?.id === names.policy || policy?.id === names.cleanupPolicy);
}

interface EnableRequest {
	app: string;
	repository: string;
	repository_id: string | number;
	branch: string;
	audience: string;
	workflow?: string;
	environment?: string;
	hostSuffix?: string;
	dataMode?: 'branched' | 'shared';
	maxPreviews?: number;
	maxTtlDays?: number;
}

/** The records `enable_previews` writes for this request, validated as far as they can be before anything exists. */
export function desiredPreviewIdentity(req: EnableRequest): { names: PreviewNames; desired: DesiredIdentity } {
	validate(
		validateBySchema(
			req,
			Joi.object({
				app: APP,
				repository: Joi.string()
					.pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
					.max(256)
					.required(),
				repository_id: Joi.alternatives()
					.try(Joi.string().pattern(/^[1-9]\d{0,19}$/), Joi.number().integer().min(1).strict())
					.required(),
				branch: Joi.string().max(255).required(),
				audience: Joi.string().min(1).max(512).required(),
				workflow: Joi.string().max(512),
				environment: Joi.string().min(1).max(255),
				hostSuffix: Joi.string().max(253),
				dataMode: Joi.string().valid('branched', 'shared'),
				maxPreviews: Joi.number().integer().min(1).strict(),
				maxTtlDays: Joi.number().greater(0).strict(),
			}).unknown(true)
		)
	);
	const names = asClientError(() => derivePreviewNames(req.app));
	const workflow = asClientError(() => canonicalWorkflowPath(req.workflow ?? PREVIEW_WORKFLOW));
	const branch = req.branch.replace(/^refs\/heads\//, '');
	if (!/^(?!-)[^\s~^:?*[\\]+$/.test(branch)) throw new ClientError(`'branch' is not a branch name: ${req.branch}`);
	const environment = req.environment ?? PREVIEW_ENVIRONMENT;
	if (environment === PREVIEW_CLEANUP_ENVIRONMENT) {
		throw new ClientError(
			`'environment' cannot be '${PREVIEW_CLEANUP_ENVIRONMENT}': that is the cleanup job's, and the two policies would match the same runs`
		);
	}
	const domain = defaultPreviewDomain(req.audience);
	const hostSuffix = (req.hostSuffix ?? (domain && `.${domain}`))?.toLowerCase();
	if (!hostSuffix) {
		throw new ClientError(`'hostSuffix' is required when the audience is not a host name, e.g. '.app.example.com'`);
	}
	const grant: ComponentGrant = {
		names: [names.components],
		constraints: {
			isolated: true,
			hostSuffix,
			...(req.dataMode !== 'shared' && { branchedDatabases: 'required' as const }),
			preview: 'required',
			...(req.maxPreviews !== undefined && { maxPreviews: req.maxPreviews }),
			maxTtlDays: req.maxTtlDays ?? DEFAULT_PREVIEW_MAX_TTL_DAYS,
		},
	};
	const grantError = componentGrantError(grant);
	if (grantError) throw new ClientError(grantError);

	const claims = {
		repository_id: String(req.repository_id),
		workflow_ref: buildWorkflowRef(req.repository, workflow, branch),
		event_name: 'pull_request_target',
	};
	const policy = (id: string, policyEnvironment: string, operations: string[], what: string): DesiredPolicy => ({
		id,
		issuer: GITHUB_ACTIONS_ISSUER,
		audience: req.audience,
		user: names.user,
		claims: { ...claims, environment: policyEnvironment },
		operations,
		description: `${what} of ${req.app} from ${req.repository} (${workflow} on ${branch})`,
	});
	const desired: DesiredIdentity = {
		role: {
			role: names.role,
			permission: { super_user: false, operations: CI_PREVIEW_OPERATIONS, component_deploy: grant },
		},
		user: { username: names.user, role: names.role },
		policies: [
			policy(names.policy, environment, CI_PREVIEW_OPERATIONS, 'PR previews'),
			policy(names.cleanupPolicy, PREVIEW_CLEANUP_ENVIRONMENT, CI_PREVIEW_CLEANUP_OPERATIONS, 'PR preview cleanup'),
		],
	};
	for (const wanted of desired.policies) assertTrustPolicyWritable({ ...wanted, operation: 'add_oidc_trust' });
	return { names, desired };
}

/** Enabled policies other than this identity's own that would match the same runs as one of `wanted`. */
function rivalPolicies(names: PreviewNames, policies: any[], wanted: DesiredPolicy[]): string[] {
	const ours = new Set([names.policy, names.cleanupPolicy]);
	return wanted.flatMap((policy) => {
		const rival = policies.find(
			(candidate) => !ours.has(candidate?.id) && candidate?.enabled !== false && policiesOverlap(candidate, policy)
		);
		return rival
			? [
					`Trust policy "${rival.id}" would also match the runs "${policy.id}" is for, and the exchange takes ` +
						`whichever comes first by id. Give this application its own workflow file (workflow=).`,
				]
			: [];
	});
}

/** Why `role` is not one `enable_previews` wrote for these names, if it is not. */
function managedRoleProblem(names: PreviewNames, role: any): string | undefined {
	const permission = role?.permission ?? {};
	const grant = permission.component_deploy;
	const otherKeys = Object.keys(permission).filter(
		(key) => !['super_user', 'operations', 'component_deploy'].includes(key)
	);
	if (
		permission.super_user === true ||
		otherKeys.length > 0 ||
		!Array.isArray(grant?.names) ||
		grant.names.length !== 1 ||
		grant.names[0] !== names.components ||
		grant.constraints?.preview !== 'required'
	) {
		return `role "${names.role}" is not a preview role for ${names.components} alone`;
	}
	return undefined;
}

async function listPolicies(req: any): Promise<any[]> {
	return (await listOidcTrust({ hdb_user: req.hdb_user, operation: 'list_oidc_trust' })).policies as any[];
}

export async function enablePreviews(req: any) {
	requireSuperUser(req);
	const { names, desired } = desiredPreviewIdentity(req);
	return withPreviewEnablementLock(req.app, async () => {
		const policies = await listPolicies(req);
		const plan = planIdentityReconcile(
			{ roles: Array.from((await listRoles()) ?? []), users: await listUsersExternal(), policies },
			desired,
			(id) => `Disable previews of ${req.app} (disable_previews) or drop it (drop_oidc_trust id=${id}) first.`
		);
		plan.conflicts.push(...rivalPolicies(names, policies, desired.policies));
		if (plan.conflicts.length > 0) {
			throw new ClientError(
				`Nothing was changed.\n${plan.conflicts.map((conflict) => `  - ${conflict}`).join('\n')}`,
				HTTP_STATUS_CODES.CONFLICT
			);
		}

		const created: string[] = [];
		if (plan.role === 'create') {
			await addRole({ role: names.role, permission: desired.role.permission });
			created.push(`role ${names.role}`);
		}
		if (plan.user === 'create') {
			await addUser({
				username: names.user,
				role: names.role,
				active: true,
				password: randomBytes(32).toString('base64url'),
			});
			created.push(`user ${names.user}`);
		}
		for (const [index, wanted] of desired.policies.entries()) {
			if (plan.policies[index] !== 'create') continue;
			// add_oidc_trust replaces, so a policy written since the listing (by hand, or from another node) would be
			// overwritten, and one that matches the same runs would leave which identity a run gets to the ids. Reading
			// again narrows both to the time between this read and the write.
			const now = await listPolicies(req);
			const raced = [
				...(now.some((policy) => policy?.id === wanted.id)
					? [`Trust policy "${wanted.id}" was created while previews of ${req.app} were being enabled.`]
					: []),
				...rivalPolicies(names, now, [wanted]),
			];
			if (raced.length > 0) {
				throw new ClientError(`${raced.join(' ')} Enable them again to check it.`, HTTP_STATUS_CODES.CONFLICT);
			}
			await addOidcTrust({ ...wanted, operation: 'add_oidc_trust', hdb_user: req.hdb_user });
			created.push(`trust policy ${wanted.id}`);
		}

		const stored = previewPolicies(names, await listPolicies(req));
		const problems = desired.policies.flatMap((wanted) => {
			const policy = stored.find((candidate) => candidate.id === wanted.id);
			if (!policy) return [`trust policy "${wanted.id}" is missing`];
			const differences = policyDifferences(policy, wanted);
			if (policy.invalid_reason) differences.push(policy.invalid_reason);
			return differences.map((difference) => `trust policy "${wanted.id}": ${difference}`);
		});
		if (problems.length > 0) {
			throw new ServerError(`Previews of ${req.app} did not verify: ${problems.join('; ')}.`);
		}
		return {
			message:
				created.length > 0
					? `Enabled previews of ${req.app}: created ${created.join(', ')}`
					: `Previews of ${req.app} were already enabled; nothing changed`,
			created,
			...(await describePreviewPolicy(req, names)),
		};
	});
}

function parseWorkflowRef(workflowRef: unknown): { repository?: string; workflow?: string; branch?: string } {
	const match = typeof workflowRef === 'string' && /^([^/]+\/[^/]+)\/(.+)@refs\/heads\/(.+)$/.exec(workflowRef);
	return match ? { repository: match[1], workflow: match[2], branch: match[3] } : {};
}

async function describePreviewPolicy(req: any, names: PreviewNames) {
	const role: any = await getRoleByName(names.role);
	const user: any = getUserWithRole(names.user);
	const trust = previewPolicies(names, await listPolicies(req));
	const deploy = trust.find((policy) => policy.id === names.policy);
	const problems: string[] = [];
	if (!role) problems.push(`role "${names.role}" is missing`);
	else {
		const roleProblem = managedRoleProblem(names, role) ?? componentGrantError(role.permission?.component_deploy);
		if (roleProblem) problems.push(roleProblem);
		const operations = role.permission?.operations;
		if (
			!Array.isArray(operations) ||
			operations.length !== CI_PREVIEW_OPERATIONS.length ||
			CI_PREVIEW_OPERATIONS.some((operation) => !operations.includes(operation))
		) {
			problems.push(
				`role "${names.role}" allows ${JSON.stringify(operations ?? null)}, not ${CI_PREVIEW_OPERATIONS.join(', ')}`
			);
		}
	}
	if (!user) problems.push(`user "${names.user}" is missing`);
	else if (user.active === false) problems.push(`user "${names.user}" is inactive`);
	else if (user.role?.role !== names.role) problems.push(`user "${names.user}" is in role "${user.role?.role}"`);
	for (const id of [names.policy, names.cleanupPolicy]) {
		const policy = trust.find((candidate) => candidate.id === id);
		if (!policy) problems.push(`trust policy "${id}" is missing`);
		else if (policy.enabled === false) problems.push(`trust policy "${id}" is disabled`);
		else if (policy.invalid_reason) problems.push(`trust policy "${id}" ${policy.invalid_reason}`);
		else if (policy.user !== names.user) problems.push(`trust policy "${id}" names user "${policy.user}"`);
	}
	return {
		app: req.app,
		enabled: problems.length === 0,
		role: names.role,
		user: names.user,
		components: names.components,
		...parseWorkflowRef(deploy?.claims?.workflow_ref),
		repository_id: deploy?.claims?.repository_id,
		environment: deploy?.claims?.environment,
		cleanupEnvironment: trust.find((policy) => policy.id === names.cleanupPolicy)?.claims?.environment,
		audience: deploy?.audience,
		grant: role?.permission?.component_deploy ?? null,
		operations: role?.permission?.operations ?? null,
		trust,
		problems,
	};
}

export async function getPreviewPolicy(req: any) {
	requireSuperUser(req);
	return describePreviewPolicy(req, previewNamesOf(req));
}

interface PreviewRelease {
	node: string;
	project: string;
	deploymentId: string;
}

/**
 * The preview releases of `app` live on each node, as each node reports them: a component named `<app>-pr-<n>` whose
 * live release was deployed as a preview of `app`. A node that cannot answer is returned as unreachable, since what it
 * holds is unknown. A component redeployed under that name as something else is not a preview release.
 */
async function livePreviewReleases(app: string): Promise<{ releases: PreviewRelease[]; unreachable: string[] }> {
	let answer: any;
	try {
		answer = await handleListReleases(
			{ operation: 'list_releases', replicated: true },
			{ timeoutMs: CENSUS_TIMEOUT_MS }
		);
	} catch (error) {
		if ((error as any)?.code !== REPLICATION_NOT_IMPLEMENTED) throw error;
		answer = { nodes: [await handleListReleases({ operation: 'list_releases' })] };
	}
	const local = new Map((await listLocalPreviews()).map((live) => [live.component, live]));
	// A release's preview metadata, from this node's provenance or its deployment row; null when neither knows it.
	const recorded = new Map<string, any>();
	const releases: PreviewRelease[] = [];
	const unreachable: string[] = [];
	const answered = new Set((answer.nodes ?? []).map((node: any) => node.node));
	for (const peer of (server as any).nodes ?? []) {
		if (peer?.name && !answered.has(peer.name)) unreachable.push(`${peer.name}: it did not answer`);
	}
	for (const node of answer.nodes ?? []) {
		if (node.error) {
			unreachable.push(`${node.node ?? 'a node'}: ${node.error}`);
			continue;
		}
		for (const { project, deployment_id: deploymentId } of node.components ?? []) {
			if (!deploymentId || !isPreviewProjectOf(app, project)) continue;
			if (!recorded.has(deploymentId)) {
				const known = local.get(project);
				const record = known?.deploymentId === deploymentId ? known : await deploymentRecord(deploymentId);
				recorded.set(deploymentId, record ? (record.preview ?? undefined) : null);
			}
			const preview = recorded.get(deploymentId);
			if (preview === null) {
				unreachable.push(
					`${node.node}: ${project} is at release ${deploymentId}, which this node has no record of yet`
				);
			} else if (preview?.app === app && isPreviewProjectOf(app, project, preview.pr)) {
				releases.push({ node: node.node, project, deploymentId });
			}
		}
	}
	return { releases, unreachable };
}

/**
 * Drops one release on the node that reported it, and only while it is still that node's live release. Not replicated:
 * a drop whose release is not the origin's own would stop on the origin before it reached the node holding it.
 */
async function dropPreviewRelease({ node, project, deploymentId }: PreviewRelease, hdbUser: any): Promise<any> {
	const operation = {
		operation: 'drop_component',
		project,
		ifDeploymentId: deploymentId,
		restart: false,
		replicated: false,
	};
	if (node === getThisNodeName()) return dropComponent({ ...operation, hdb_user: hdbUser });
	const peer = (server as any).nodes?.find((candidate: any) => candidate?.name === node);
	if (!peer) throw new Error(`${node} is not among this node's peers`);
	return server.replication.sendOperationToNode(peer, operation, { timeoutMs: PEER_DROP_TIMEOUT_MS });
}

/** Previews of `app` whose deploy had not finished when this looked; one admitted before a revocation can still go live. */
async function previewsInProgress(app: string): Promise<string[]> {
	const deployments = (databases as any).system?.hdb_deployment;
	if (!deployments) return [];
	const projects = new Set<string>();
	for await (const row of deployments.search([
		{ attribute: 'project', comparator: 'starts_with', value: `${app}-pr-` },
	])) {
		if (row?.preview?.app === app && !ENDED_DEPLOYMENT_STATUSES.has(row.status)) projects.add(row.project);
	}
	return [...projects].sort();
}

/** Why a record named like this application's preview identity is not one `enable_previews` wrote, if it is not. */
function foreignRecords(names: PreviewNames, role: any, users: any[], policies: any[]): string[] {
	const problems: string[] = [];
	const roleProblem = role && managedRoleProblem(names, role);
	if (roleProblem) problems.push(`The ${roleProblem}.`);
	for (const user of users) {
		const roleName = typeof user?.role === 'object' ? user.role?.role : user?.role;
		if (user?.username === names.user && roleName !== names.role) {
			problems.push(`User "${names.user}" is in role "${roleName}", not "${names.role}".`);
		}
		if (user?.username !== names.user && roleName === names.role) {
			problems.push(`User "${user.username}" is also in role "${names.role}".`);
		}
	}
	for (const policy of policies) {
		if (policy.user !== names.user) {
			problems.push(`Trust policy "${policy.id}" names user "${policy.user}", not "${names.user}".`);
		}
	}
	return problems;
}

/**
 * Revokes first and removes last: the trust policies go, so no run can authenticate, and the user is deactivated, so
 * an issued token stops working; then each preview release of the application is dropped on every node; only then the
 * user and the role. A drop that fails anywhere, or a node that cannot say what it holds, stops it there with the
 * identity revoked, and running it again resumes.
 */
export async function disablePreviews(req: any) {
	requireSuperUser(req);
	const names = previewNamesOf(req);
	return withPreviewEnablementLock(req.app, async () => {
		const role: any = await getRoleByName(names.role);
		const users = await listUsersExternal();
		const policies = previewPolicies(names, await listPolicies(req));
		const foreign = foreignRecords(names, role, users, policies);
		if (foreign.length > 0) {
			throw new ClientError(
				`Nothing was changed.\n${foreign.map((problem) => `  - ${problem}`).join('\n')}`,
				HTTP_STATUS_CODES.CONFLICT
			);
		}
		const removed: string[] = [];
		for (const policy of policies) {
			await dropOidcTrust({ id: policy.id, operation: 'drop_oidc_trust', hdb_user: req.hdb_user });
			removed.push(`trust policy ${policy.id}`);
		}
		const user: any = getUserWithRole(names.user);
		if (user && user.active !== false) await alterUser({ username: names.user, active: false });

		const { releases, unreachable } = await livePreviewReleases(req.app);
		const dropped: any[] = [];
		const failed = [...unreachable];
		for (const release of releases) {
			try {
				const answer: any = await dropPreviewRelease(release, req.hdb_user);
				const outcome = answer?.value ?? answer?.body ?? answer;
				dropped.push({ ...release, componentRemoved: outcome?.componentRemoved, message: outcome?.message });
			} catch (error) {
				dropped.push({ ...release, error: (error as Error).message });
				failed.push(`${release.project} on ${release.node}: ${(error as Error).message}`);
			}
		}
		if (failed.length > 0) {
			throw new ServerError(
				`Previews of ${req.app} are revoked but not removed: ${failed.join('; ')}. The trust policies are gone and ` +
					`${names.user} is inactive; disable previews again to retry the drops and remove the user and role. ` +
					'Branched storage that a failed drop left behind is not live, so a rerun does not see it: ' +
					'drop_component of that project on that node removes it.'
			);
		}
		if (user) {
			await dropUser({ username: names.user });
			removed.push(`user ${names.user}`);
		}
		if (role) {
			await dropRole({ id: role.id });
			removed.push(`role ${names.role}`);
		}
		const inProgress = await previewsInProgress(req.app);
		return {
			message:
				removed.length + dropped.length > 0
					? `Disabled previews of ${req.app}`
					: `Previews of ${req.app} were not enabled; nothing changed`,
			app: req.app,
			dropped,
			removed,
			...(inProgress.length > 0 && { inProgress }),
		};
	});
}
