// `enable_previews` / `disable_previews` / `get_preview_policy`: an application's PR-preview identity and policy, set
// up and removed by the cluster so every client (the CLI, Studio's preview panel) gets the same records. Why these are
// operations rather than client compositions, and what each guarantees: security/DESIGN.md, "PR previews are enabled
// by the cluster".
//
// The records are system-table rows, which harper-pro replicates, so none of this calls replicateOperation; the
// preview drops in disable are replicated drop_component calls, which replicate themselves.

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
import { previewExpiresAtMs } from './deploymentProvenance.ts';
import { listLocalPreviews } from './previews.ts';
import { withComponentPreparationLock } from './componentPreparationLock.ts';
import { dropComponent } from './operations.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
const ENDED_DEPLOYMENT_STATUSES = new Set(['success', 'partial', 'failed', 'rolled_back', 'staged']);

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

/** The shared derivations throw an Error carrying statusCode 400; here it is a client error like any other. */
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

/** One enable or disable of an application at a time on this node; a writer on another node is not excluded. */
function withPreviewEnablementLock<T>(app: string, run: () => Promise<T>): Promise<T> {
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT) as string;
	return withComponentPreparationLock(join(componentsRoot, `.preview-enablement-${app}`), run, {
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
				branch: Joi.string()
					.pattern(/^(?!-)[^\s~^:?*[\\]+$/)
					.max(255)
					.required(),
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
			...(req.maxTtlDays !== undefined && { maxTtlDays: req.maxTtlDays }),
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
		const ours = new Set([names.policy, names.cleanupPolicy]);
		for (const wanted of desired.policies) {
			const rival = policies.find(
				(policy) => !ours.has(policy?.id) && policy?.enabled !== false && policiesOverlap(policy, wanted)
			);
			if (rival) {
				plan.conflicts.push(
					`Trust policy "${rival.id}" would also match the runs "${wanted.id}" is for, and the exchange takes ` +
						`whichever comes first by id. Give this application its own workflow file (workflow=).`
				);
			}
		}
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
				// Nothing signs in with it: runs authenticate through the trust policies.
				password: randomBytes(32).toString('base64url'),
			});
			created.push(`user ${names.user}`);
		}
		for (const [index, wanted] of desired.policies.entries()) {
			if (plan.policies[index] !== 'create') continue;
			// add_oidc_trust replaces, so a policy written since the listing (by hand, or from another node) would be
			// overwritten; reading again narrows that to the time between this read and the write.
			if ((await listPolicies(req)).some((policy) => policy?.id === wanted.id)) {
				throw new ClientError(
					`Trust policy "${wanted.id}" was created while previews of ${req.app} were being enabled. Enable them again to check it.`,
					HTTP_STATUS_CODES.CONFLICT
				);
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

/**
 * The components disable may drop: named `<app>-pr-<n>` and recorded as a preview of `app`, by this node's provenance
 * or by a deployment row (replicated, so a preview only a peer holds is still named) whose preview has not expired.
 * `shop-pr-tools`, or a preview of `shop-pr`, is never a preview of `shop`.
 */
async function ownedPreviews(app: string, now = Date.now()): Promise<{ projects: string[]; inProgress: string[] }> {
	const projects = new Set<string>();
	for (const live of await listLocalPreviews()) {
		if (live.preview.app === app && isPreviewProjectOf(app, live.component, live.preview.pr)) {
			projects.add(live.component);
		}
	}
	const inProgress = new Set<string>();
	const deployments = (databases as any).system?.hdb_deployment;
	if (deployments) {
		for await (const row of deployments.search([
			{ attribute: 'project', comparator: 'starts_with', value: `${app}-pr-` },
		])) {
			const preview = row?.preview;
			if (preview?.app !== app || !isPreviewProjectOf(app, row.project, preview.pr)) continue;
			if (!ENDED_DEPLOYMENT_STATUSES.has(row.status)) inProgress.add(row.project);
			const expiresAt = previewExpiresAtMs(preview);
			if (expiresAt === undefined || expiresAt > now) projects.add(row.project);
		}
	}
	return { projects: [...projects].sort(), inProgress: [...inProgress].sort() };
}

/** Why a record named like this application's preview identity is not one `enable_previews` wrote, if it is not. */
function foreignRecords(names: PreviewNames, role: any, users: any[], policies: any[]): string[] {
	const problems: string[] = [];
	if (role) {
		const permission = role.permission ?? {};
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
			problems.push(`Role "${names.role}" is not a preview role for ${names.components} alone.`);
		}
	}
	for (const user of users) {
		const roleName = typeof user?.role === 'object' ? user.role?.role : user?.role;
		if (user?.username === names.user && role && roleName !== names.role) {
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
 * an issued token stops working; then each preview of the application is dropped on every node; only then the user
 * and the role. A drop that fails anywhere stops it there with the identity revoked, and running it again resumes.
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

		const { projects, inProgress } = await ownedPreviews(req.app);
		const dropped: any[] = [];
		const failed: string[] = [];
		for (const project of projects) {
			try {
				const response: any = await dropComponent({
					operation: 'drop_component',
					project,
					restart: false,
					hdb_user: req.hdb_user,
				});
				dropped.push({ project, ...response });
				for (const peer of response?.replicated ?? []) {
					if (peer?.status === 'failed' || peer?.error)
						failed.push(`${project} on ${peer.node ?? 'a peer'}: ${peer.error}`);
				}
			} catch (error) {
				dropped.push({ project, error: (error as Error).message });
				failed.push(`${project}: ${(error as Error).message}`);
			}
		}
		if (failed.length > 0) {
			throw new ServerError(
				`Previews of ${req.app} are revoked but not removed: ${failed.join('; ')}. The trust policies are gone and ` +
					`${names.user} is inactive; disable previews again to retry the drops and remove the user and role.`
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
		return {
			message:
				removed.length + dropped.length > 0
					? `Disabled previews of ${req.app}`
					: `Previews of ${req.app} were not enabled; nothing changed`,
			app: req.app,
			dropped,
			removed,
			// Deploys admitted before the revocation may still go live; each is bound by its own expiry.
			...(inProgress.length > 0 && { inProgress }),
		};
	});
}
