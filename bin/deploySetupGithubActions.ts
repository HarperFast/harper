'use strict';

// `harper deploy setup=true provider=github-actions` — the one-time cluster setup a GitHub Actions
// workflow needs to deploy with its OIDC identity token instead of a stored credential: a deploy-only
// role, a user in it, and a trust policy matching the token the workflow presents.
//
// The policy has to match the token claim for claim, and a mismatch reaches CI only as a bare 401
// (the exchange deliberately does not say which check failed). So every claim is derived from the
// sources the workflow and the CLI use — the repository's numeric id, the workflow file in this
// checkout, and the target exactly as the CLI normalizes it for the audience — and the stored policy
// is read back and compared before setup reports success.
//
// Setup only creates what is missing. An existing role, user or policy that already matches is left
// alone; one that differs, or that someone disabled, stops setup before it writes anything. Altering
// a record could repurpose a role another application uses, and re-enabling one would undo a
// revocation.

import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { prompts } from '../utility/interactivePrompts.ts';
import { cliOperations, resolveGitRepo } from './cliOperations.ts';
import { normalizeTarget } from './cliCredentials.ts';

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
export const CI_DEPLOY_OPERATIONS = ['deploy_component', 'get_job'];
const DEFAULT_WORKFLOW = '.github/workflows/deploy.yaml';
const DEFAULT_BRANCH = 'main';
const DEFAULT_ENVIRONMENT = 'production';
// add_oidc_trust's id grammar (security/authn/oidc/trustPolicyOperations.ts).
const POLICY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHILD_PROCESS_TIMEOUT_MS = 15_000;

function cliError(message: string): Error {
	return Object.assign(new Error(message), { statusCode: 400 });
}

export interface CiNames {
	role: string;
	user: string;
	policy: string;
}

/** The names Studio's GitHub Actions setup (HarperFast/studio#1788) must also use. */
export function deriveCiNames(component: string): CiNames {
	const names = {
		role: `${component}-ci-deploy`,
		user: `${component}-ci-deploy`,
		policy: `github-actions-${component}`,
	};
	if (!POLICY_ID_PATTERN.test(names.policy)) {
		throw cliError(`"${names.policy}" is not a valid trust policy id (1–128 letters, numbers, "_", "-" or ".").`);
	}
	return names;
}

export function buildWorkflowRef(repository: string, workflow: string, branch: string): string {
	return `${repository}/${workflow.replace(/^\.?\//, '')}@refs/heads/${branch}`;
}

/** An argument as typed: `branch=1.0` must stay "1.0", not become the number 1. */
export function rawStringArg(req: any, name: string): string | undefined {
	const raw = req._rawArgs?.[name];
	if (typeof raw === 'string') return raw.trim() || undefined;
	const value = req[name];
	if (value === undefined || value === null || value === '') return undefined;
	return String(value).trim() || undefined;
}

export interface WorkflowCheck {
	problems: string[];
	unverified: string[];
}

function asList(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

const isExpression = (value: unknown) => typeof value === 'string' && value.includes('${{');

/**
 * Checks the workflow file against the branch and environment the policy will pin. A literal value
 * that disagrees is a problem — no run of that workflow could match the policy. A value this cannot
 * read (an expression, or no filter at all) is reported as unverified rather than assumed to match.
 */
export function checkWorkflowFile(content: string, branch: string, environment: string): WorkflowCheck {
	const problems: string[] = [];
	const unverified: string[] = [];
	let workflow: any;
	try {
		workflow = YAML.parse(content);
	} catch (error) {
		return { problems: [`it is not valid YAML: ${(error as Error).message}`], unverified };
	}
	const triggers = workflow?.on;
	const push = triggers && typeof triggers === 'object' && !Array.isArray(triggers) ? triggers.push : undefined;
	const branches = asList(push?.branches);
	if (branches.length === 0) {
		unverified.push(`that it deploys from "${branch}" (it has no on.push.branches filter)`);
	} else if (!branches.includes(branch)) {
		// Entries are glob patterns; matching them is GitHub's job, so a pattern is only unverified.
		if (branches.some((entry) => isExpression(entry) || /[*?[!]/.test(String(entry)))) {
			unverified.push(`that ${branches.join(', ')} matches "${branch}"`);
		} else {
			problems.push(`it deploys on pushes to ${branches.join(', ')}, not "${branch}"`);
		}
	}

	const environments = Object.values(workflow?.jobs ?? {})
		.map((job: any) => (typeof job?.environment === 'object' ? job.environment?.name : job?.environment))
		.filter((name) => name !== undefined && name !== null);
	const literal = environments.filter((name) => !isExpression(name));
	if (literal.includes(environment)) return { problems, unverified };
	if (literal.length > 0 && literal.length === environments.length) {
		problems.push(`its jobs use environment ${literal.join(', ')}, not "${environment}"`);
	} else {
		unverified.push(`that a job runs in the "${environment}" environment`);
	}
	return { problems, unverified };
}

export interface DesiredRecords {
	role: { role: string; permission: { super_user: false; operations: string[] } };
	user: { username: string; role: string };
	policy: {
		id: string;
		issuer: string;
		audience: string;
		user: string;
		claims: Record<string, string>;
		operations: string[];
		description: string;
	};
}

const sameSet = (left: unknown, right: string[]) =>
	Array.isArray(left) && left.length === right.length && right.every((entry) => left.includes(entry));

const ROLE_FLAGS = new Set(['super_user', 'structure_user', 'cluster_user', 'operations']);

/** Undefined when an existing role grants exactly the deploy role's permission, else what differs. */
export function roleDifference(existing: any, desired: DesiredRecords['role']): string | undefined {
	const permission = existing?.permission ?? {};
	if (permission.super_user === true) return 'it is a super_user role';
	for (const flag of ['structure_user', 'cluster_user']) {
		if (permission[flag]) return `it sets ${flag}`;
	}
	if (!sameSet(permission.operations, desired.permission.operations)) {
		return `its operations are ${JSON.stringify(permission.operations ?? null)}, not ${JSON.stringify(desired.permission.operations)}`;
	}
	const tableGrants = Object.keys(permission).filter((key) => !ROLE_FLAGS.has(key));
	if (tableGrants.length > 0) return `it grants database permissions (${tableGrants.join(', ')})`;
	return undefined;
}

export function userDifference(existing: any, desired: DesiredRecords['user']): string | undefined {
	const roleName = typeof existing?.role === 'object' ? existing.role?.role : existing?.role;
	if (roleName !== desired.role) return `it is in role "${roleName}", not "${desired.role}"`;
	if (existing.active === false) return 'it is inactive';
	return undefined;
}

export function policyDifferences(existing: any, desired: DesiredRecords['policy']): string[] {
	const differences: string[] = [];
	for (const field of ['issuer', 'audience', 'user'] as const) {
		if (existing?.[field] !== desired[field]) {
			differences.push(`${field} is ${JSON.stringify(existing?.[field])}, not ${JSON.stringify(desired[field])}`);
		}
	}
	const claims = existing?.claims ?? {};
	const claimNames = new Set([...Object.keys(claims), ...Object.keys(desired.claims)]);
	for (const name of claimNames) {
		if (claims[name] !== desired.claims[name]) {
			differences.push(`claim ${name} is ${JSON.stringify(claims[name])}, not ${JSON.stringify(desired.claims[name])}`);
		}
	}
	if (!sameSet(existing?.operations, desired.operations)) {
		differences.push(
			`operations are ${JSON.stringify(existing?.operations ?? null)}, not ${JSON.stringify(desired.operations)}`
		);
	}
	if (existing?.enabled === false) differences.push('it is disabled');
	return differences;
}

export type Reconcile = 'create' | 'keep';

export interface ReconcilePlan {
	role: Reconcile;
	user: Reconcile;
	policy: Reconcile;
	conflicts: string[];
}

export function planReconcile(
	existing: { roles: any[]; users: any[]; policies: any[] },
	desired: DesiredRecords
): ReconcilePlan {
	const conflicts: string[] = [];
	const role = existing.roles.find((candidate) => candidate?.role === desired.role.role);
	const roleProblem = role && roleDifference(role, desired.role);
	if (roleProblem) conflicts.push(`Role "${desired.role.role}" already exists and ${roleProblem}.`);

	const user = existing.users.find((candidate) => candidate?.username === desired.user.username);
	const userProblem = user && userDifference(user, desired.user);
	if (userProblem) conflicts.push(`User "${desired.user.username}" already exists and ${userProblem}.`);

	const policy = existing.policies.find((candidate) => candidate?.id === desired.policy.id);
	const policyProblems = policy ? policyDifferences(policy, desired.policy) : [];
	if (policyProblems.length > 0) {
		conflicts.push(
			`Trust policy "${desired.policy.id}" already exists and ${policyProblems.join('; ')}. If it should be replaced, ` +
				`drop it with \`harper drop_oidc_trust id=${desired.policy.id}\` and run setup again.`
		);
	}
	return {
		role: role ? 'keep' : 'create',
		user: user ? 'keep' : 'create',
		policy: policy ? 'keep' : 'create',
		conflicts,
	};
}

interface RepositoryInfo {
	id: string;
	fullName: string;
	defaultBranch?: string;
}

function parseRepositoryResponse(body: unknown): RepositoryInfo | undefined {
	const data = body as any;
	if (!Number.isSafeInteger(data?.id) || data.id <= 0 || typeof data?.full_name !== 'string') return undefined;
	return {
		id: String(data.id),
		fullName: data.full_name,
		defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : undefined,
	};
}

/** `gh` (which can see a private repository) first, then the public API; both bound to github.com. */
async function lookupRepository(repository: string): Promise<RepositoryInfo | undefined> {
	const gh = spawnSync('gh', ['api', '--hostname', 'github.com', `repos/${repository}`], {
		encoding: 'utf8',
		timeout: CHILD_PROCESS_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (gh.status === 0) {
		try {
			const info = parseRepositoryResponse(JSON.parse(gh.stdout));
			if (info) return info;
		} catch {}
	}
	try {
		const response = await fetch(`https://api.github.com/repos/${repository}`, {
			headers: { Accept: 'application/vnd.github+json' },
			signal: AbortSignal.timeout(CHILD_PROCESS_TIMEOUT_MS),
		});
		if (response.ok) return parseRepositoryResponse(await response.json());
	} catch {}
	return undefined;
}

function gitTopLevel(): string {
	const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
		encoding: 'utf8',
		timeout: CHILD_PROCESS_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : process.cwd();
}

async function resolveRepository(req: any, interactive: boolean): Promise<string> {
	let repository = rawStringArg(req, 'repo');
	if (!repository) {
		let detected: string | undefined;
		try {
			detected = resolveGitRepo();
		} catch {
			// No GitHub origin remote; ask, or require repo=.
		}
		if (interactive) {
			repository = (
				await prompts.input({ message: 'GitHub repository that deploys (owner/name):', default: detected })
			)?.trim();
		} else {
			repository = detected;
		}
	}
	if (!repository || !REPO_PATTERN.test(repository)) {
		throw cliError(`Pass the GitHub repository as repo=<owner>/<name>${repository ? ` (got "${repository}")` : ''}.`);
	}
	return repository;
}

async function resolveRepositoryId(req: any, info: RepositoryInfo | undefined, interactive: boolean): Promise<string> {
	let id = rawStringArg(req, 'repository_id') ?? info?.id;
	if (!id && interactive) {
		id = (
			await prompts.input({
				message: "Couldn't look the repository up. Its numeric id (gh api repos/<owner>/<name> --jq .id):",
			})
		)?.trim();
	}
	if (!id || !/^[1-9]\d*$/.test(id)) {
		throw cliError(
			`Couldn't determine the repository's numeric id${id ? ` ("${id}" is not one)` : ''}. Sign in with \`gh auth login\`, ` +
				'or pass repository_id=<id> (gh api repos/<owner>/<name> --jq .id).'
		);
	}
	return id;
}

function setGithubVariable(repository: string, value: string): { ok: boolean; reason?: string } {
	const result = spawnSync(
		'gh',
		['variable', 'set', 'HARPER_CLI_TARGET', '--repo', `github.com/${repository}`, '--body', value],
		{ encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	if (result.error) {
		return {
			ok: false,
			reason: (result.error as any).code === 'ENOENT' ? 'the gh CLI is not installed' : result.error.message,
		};
	}
	if (result.status !== 0) return { ok: false, reason: result.stderr.trim() || `gh exited with ${result.status}` };
	return { ok: true };
}

export async function setupGithubActions(req: any, transport: any, component: string): Promise<void> {
	const interactive = Boolean(process.stdin.isTTY);
	const names = deriveCiNames(component);

	const initial: any = await cliOperations({ ...transport, operation: 'list_oidc_trust' }, true);
	const resolvedTarget: string | undefined = initial?.resolvedTarget;
	if (!resolvedTarget) {
		throw cliError(
			'GitHub Actions setup needs a remote cluster: pass target=<url>, set HARPER_CLI_TARGET, or run `harper login <url>` first.'
		);
	}
	// Pinned, so a `harper login` elsewhere during setup can't move the later writes to another cluster.
	if (!transport.target) transport.target = resolvedTarget;
	const audience = normalizeTarget(resolvedTarget);

	const repository = await resolveRepository(req, interactive);
	// An explicit repository_id is the caller's word for the identity; looking it up anyway would make
	// an offline or scripted run depend on the network.
	const info = rawStringArg(req, 'repository_id') ? undefined : await lookupRepository(repository);
	const repositoryId = await resolveRepositoryId(req, info, interactive);
	const fullName = info?.fullName ?? repository;
	const workflow = rawStringArg(req, 'workflow') ?? DEFAULT_WORKFLOW;
	const branch = rawStringArg(req, 'branch') ?? DEFAULT_BRANCH;
	const environment = rawStringArg(req, 'environment') ?? DEFAULT_ENVIRONMENT;

	const notes: string[] = [];
	if (!info) {
		notes.push(
			`The repository name was not looked up, so its casing was not verified: workflow_ref is compared exactly, ` +
				`so "${fullName}" must be spelled as GitHub spells it.`
		);
	}
	if (info?.defaultBranch && info.defaultBranch !== branch) {
		notes.push(`The repository's default branch is "${info.defaultBranch}"; the policy pins "${branch}".`);
	}
	const workflowPath = join(gitTopLevel(), workflow);
	if (existsSync(workflowPath) && !statSync(workflowPath).isFile()) {
		throw cliError(`workflow=${workflow} is not a file.`);
	}
	if (existsSync(workflowPath)) {
		const check = checkWorkflowFile(readFileSync(workflowPath, 'utf8'), branch, environment);
		if (check.problems.length > 0) {
			throw cliError(
				`${workflow} cannot match the trust policy: ${check.problems.join('; ')}. Pass branch= or environment= to ` +
					'match the workflow, or change the workflow.'
			);
		}
		for (const item of check.unverified) notes.push(`Not verified from ${workflow}: ${item}.`);
	} else {
		notes.push(`${workflow} is not in this checkout, so its branch and environment were not checked.`);
	}

	const desired: DesiredRecords = {
		role: { role: names.role, permission: { super_user: false, operations: CI_DEPLOY_OPERATIONS } },
		user: { username: names.user, role: names.role },
		policy: {
			id: names.policy,
			issuer: GITHUB_ACTIONS_ISSUER,
			audience,
			user: names.user,
			claims: {
				repository_id: repositoryId,
				workflow_ref: buildWorkflowRef(fullName, workflow, branch),
				environment,
			},
			operations: CI_DEPLOY_OPERATIONS,
			description: `GitHub Actions deploys of ${component} from ${fullName} (${workflow} on ${branch})`,
		},
	};

	const roles: any = await cliOperations({ ...transport, operation: 'list_roles' }, true);
	const users: any = await cliOperations({ ...transport, operation: 'list_users' }, true);
	const plan = planReconcile(
		{ roles: asList(roles), users: asList(users), policies: asList(initial?.policies) },
		desired
	);
	if (plan.conflicts.length > 0) {
		throw cliError(`Nothing was changed.\n${plan.conflicts.map((conflict) => `  - ${conflict}`).join('\n')}`);
	}

	const created: string[] = [];
	if (plan.role === 'create' || plan.user === 'create' || plan.policy === 'create') {
		console.log(chalk.gray('Creating what is missing. If this stops partway, run it again to finish.'));
	}
	if (plan.role === 'create') {
		await cliOperations({ ...transport, operation: 'add_role', ...desired.role }, true);
		created.push(`role ${names.role}`);
	}
	if (plan.user === 'create') {
		await cliOperations(
			{
				...transport,
				operation: 'add_user',
				username: names.user,
				role: names.role,
				active: true,
				// Nothing signs in with it: runs authenticate through the trust policy.
				password: randomBytes(32).toString('base64url'),
			},
			true
		);
		created.push(`user ${names.user}`);
	}
	if (plan.policy === 'create') {
		const response: any = await cliOperations({ ...transport, operation: 'add_oidc_trust', ...desired.policy }, true);
		if (response?.warning) console.log(chalk.yellow(response.warning));
		created.push(`trust policy ${names.policy}`);
	}

	const after: any = await cliOperations({ ...transport, operation: 'list_oidc_trust' }, true);
	const stored = asList(after?.policies).find((policy: any) => policy?.id === names.policy) as any;
	const verifyProblems = stored ? policyDifferences(stored, desired.policy) : ['it is missing'];
	if (stored?.invalid_reason) verifyProblems.push(stored.invalid_reason);
	if (verifyProblems.length > 0) {
		throw cliError(`Trust policy "${names.policy}" did not verify: ${verifyProblems.join('; ')}.`);
	}

	console.log(chalk.green(`\n✓ ${fullName} can deploy ${component} to ${audience} from GitHub Actions.`));
	console.log(
		chalk.gray(
			`  ${created.length > 0 ? `Created ${created.join(', ')}.` : 'Everything already matched; nothing was changed.'}\n` +
				`  Runs of ${workflow} on ${branch}, in the ${environment} environment, act as ${names.user}, which can ` +
				`run ${CI_DEPLOY_OPERATIONS.join(' and ')} — for any component on this cluster, not only ${component}.`
		)
	);
	for (const note of notes) console.log(chalk.yellow(`  ${note}`));
	console.log(
		chalk.gray(
			`  To revoke: harper drop_oidc_trust id=${names.policy} stops new runs; ` +
				`harper alter_user username=${names.user} active=false also stops a token already issued (it lasts an hour).`
		)
	);

	const variable = setGithubVariable(fullName, audience);
	if (!variable.ok) {
		throw cliError(
			`The cluster is set up, but the HARPER_CLI_TARGET repository variable was not set (${variable.reason}). Set it with:\n` +
				`  gh variable set HARPER_CLI_TARGET --repo ${fullName} --body ${audience}`
		);
	}
	console.log(chalk.green(`✓ Set the HARPER_CLI_TARGET variable on ${fullName} to ${audience}.`));
}
