'use strict';

// `harper deploy setup=true provider=github-actions`: the role, user and trust policy a GitHub Actions
// workflow needs to deploy with its OIDC identity token. Why it only creates, and how it keeps the
// policy matching the token, is in security/DESIGN.md (OIDC trusted publishing).

import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { prompts } from '../utility/interactivePrompts.ts';
import { cliOperations, resolveGitRepo } from './cliOperations.ts';
import { normalizeTarget } from './cliCredentials.ts';
import { GITHUB_ACTIONS_ISSUER, buildWorkflowRef, canonicalWorkflowPath } from '../utility/previewIdentity.ts';
import {
	planIdentityReconcile,
	policyDifferences,
	policiesOverlap,
	roleDifference,
	sameAuthority,
	userDifference,
	type DesiredPolicy,
	type DesiredRole,
	type DesiredUser,
	type Reconcile,
} from '../security/ciIdentity.ts';

export {
	GITHUB_ACTIONS_ISSUER,
	buildWorkflowRef,
	canonicalWorkflowPath,
	policyDifferences,
	roleDifference,
	userDifference,
};
// `get_deployment` is how `harper deploy restart=rolling` waits for the other nodes; `get_job` is kept for workflows
// that still poll the activation job themselves. `registration_info` (which returns only Harper's version) is the
// CLI's check before a deploy: refused, the deploy still works, but the cluster logs a denial on every run.
export const CI_DEPLOY_OPERATIONS = ['deploy_component', 'get_deployment', 'get_job', 'registration_info'];
const DEFAULT_WORKFLOW = '.github/workflows/deploy.yaml';
const DEFAULT_BRANCH = 'main';
const DEFAULT_ENVIRONMENT = 'production';
// add_oidc_trust's id grammar (security/authn/oidc/trustPolicyOperations.ts).
const POLICY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHILD_PROCESS_TIMEOUT_MS = 15_000;
const TARGET_VARIABLE = 'HARPER_CLI_TARGET';

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
	/** What could hand the identity to a fork or to a PR's code, and could not be ruled out. */
	unsafe?: string[];
}

function asList(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

const isExpression = (value: unknown) => typeof value === 'string' && value.includes('${{');

const environmentName = (job: any) => (typeof job?.environment === 'object' ? job.environment?.name : job?.environment);

/** A job's own `permissions` replace the workflow's; with neither, GitHub's defaults grant no identity token. */
function grantsIdToken(job: any, workflow: any): boolean {
	const permissions = job?.permissions ?? workflow?.permissions;
	if (permissions === 'write-all') return true;
	return typeof permissions === 'object' && permissions !== null && permissions['id-token'] === 'write';
}

function parseWorkflow(content: string): { workflow?: any; error?: string } {
	try {
		// Failsafe keeps every scalar as written: the default schema reads `branches: [1.0]` as the number 1.
		return { workflow: YAML.parse(content, { schema: 'failsafe' }) };
	} catch (error) {
		return { error: `it is not valid YAML: ${(error as Error).message}` };
	}
}

/**
 * Checks the workflow file against the branch and environment the policy will pin. A literal value
 * that disagrees is a problem — no run of that workflow could match the policy. A value this cannot
 * read (an expression, or no filter at all) is reported as unverified rather than assumed to match.
 */
export function checkWorkflowFile(content: string, branch: string, environment: string): WorkflowCheck {
	const problems: string[] = [];
	const unverified: string[] = [];
	const { workflow, error } = parseWorkflow(content);
	if (error) return { problems: [error], unverified };
	const triggers = workflow?.on;
	const push = triggers && typeof triggers === 'object' && !Array.isArray(triggers) ? triggers.push : undefined;
	const branches = asList(push?.branches);
	const otherTriggers =
		triggers && typeof triggers === 'object' && !Array.isArray(triggers)
			? Object.keys(triggers).filter((name) => !['push', 'pull_request', 'pull_request_target'].includes(name))
			: [];
	if (branches.length === 0) {
		unverified.push(`that it deploys from "${branch}" (it has no on.push.branches filter)`);
	} else if (!branches.includes(branch)) {
		// Entries are glob patterns; matching them is GitHub's job, so a pattern is only unverified.
		if (branches.some((entry) => isExpression(entry) || /[*?[!+]/.test(String(entry)))) {
			unverified.push(`that ${branches.join(', ')} matches "${branch}"`);
		} else if (otherTriggers.length > 0) {
			// A manual, scheduled or dispatched run can run on the branch the push filter leaves out.
			unverified.push(`that "${branch}" deploys: only ${otherTriggers.join(', ')} can run it there`);
		} else {
			problems.push(`it deploys on pushes to ${branches.join(', ')}, not "${branch}"`);
		}
	}
	checkEnvironmentJobs(workflow, environment, problems, unverified);
	return { problems, unverified };
}

function checkEnvironmentJobs(workflow: any, environment: string, problems: string[], unverified: string[]): void {
	const jobs: any[] = Object.values(workflow?.jobs ?? {});
	const environments = jobs.map(environmentName).filter((name) => name !== undefined && name !== null);
	const literal = environments.filter((name) => !isExpression(name));
	// A reusable workflow (`uses:`) can set the environment in the file it calls, out of sight here.
	const callsReusable = jobs.some((job: any) => typeof job?.uses === 'string');
	if (literal.includes(environment)) {
		if (!jobs.some((job: any) => environmentName(job) === environment && grantsIdToken(job, workflow))) {
			// The job that deploys may be a reusable workflow that sets the environment and permissions itself.
			if (callsReusable) {
				unverified.push(`that a job in the "${environment}" environment has \`permissions: id-token: write\``);
			} else {
				problems.push(
					`no job in the "${environment}" environment has \`permissions: id-token: write\`, so no run can request a token`
				);
			}
		}
		return;
	}
	if (environments.length === 0 && !callsReusable) {
		// GitHub omits the environment claim for a job with none, so the policy could never match.
		problems.push(`no job sets an environment, so no run's token carries "${environment}"`);
	} else if (literal.length > 0 && literal.length === environments.length && !callsReusable) {
		problems.push(`its jobs use environment ${literal.join(', ')}, not "${environment}"`);
	} else {
		unverified.push(`that a job runs in the "${environment}" environment`);
	}
}

function triggerEvents(triggers: unknown): { names: string[]; config: Record<string, any> } {
	if (typeof triggers === 'string') return { names: [triggers], config: {} };
	if (Array.isArray(triggers)) return { names: triggers.map(String), config: {} };
	if (triggers && typeof triggers === 'object') return { names: Object.keys(triggers), config: triggers };
	return { names: [], config: {} };
}

const HEAD_REPOSITORY = String.raw`github\.event\.pull_request\.head\.repo`;
const BASE_REPOSITORY = String.raw`(?:github\.repository|github\.event\.pull_request\.base\.repo\.full_name)`;
/**
 * A whole `&&` term that admits only same-repository pull requests. Not `head.repo.fork`: it describes the head
 * repository alone, so it is false for a PR from the root of the base's own fork network, and a deleted fork's null
 * head passes `!fork`.
 */
const SAME_REPOSITORY_TERM = new RegExp(
	`^(?:${HEAD_REPOSITORY}\\.full_name\\s*==\\s*${BASE_REPOSITORY}|${BASE_REPOSITORY}\\s*==\\s*${HEAD_REPOSITORY}\\.full_name)$`
);

function withoutEnclosingParentheses(term: string): string {
	let text = term.trim();
	for (;;) {
		if (!text.startsWith('(') || !text.endsWith(')')) return text;
		let depth = 0;
		const inner = text.slice(1, -1);
		for (const character of inner) {
			depth += character === '(' ? 1 : character === ')' ? -1 : 0;
			if (depth < 0) return text;
		}
		text = inner.trim();
	}
}

/** The top-level `&&` terms of an expression; undefined when it has a top-level `||`. */
function conjuncts(expression: string): string[] | undefined {
	const terms: string[] = [];
	let depth = 0;
	let start = 0;
	let quoted = false;
	for (let index = 0; index < expression.length; index++) {
		const character = expression[index];
		if (character === "'") quoted = !quoted;
		if (quoted) continue;
		if (character === '(') depth++;
		else if (character === ')') depth--;
		else if (depth === 0 && expression.startsWith('||', index)) return undefined;
		else if (depth === 0 && expression.startsWith('&&', index)) {
			terms.push(expression.slice(start, index));
			start = index + 2;
			index++;
		}
	}
	terms.push(expression.slice(start));
	return terms.map(withoutEnclosingParentheses);
}

const PULL_REQUEST_HEAD = /head\.sha|head\.ref|head\.repo|head_ref|merge_commit_sha|refs\/pull\//;
const PR_HEAD_SHELL_CHECKOUT =
	/\bgh\s+pr\s+checkout\b|\bgit\b[^\n]*\b(?:checkout|switch|fetch|pull|worktree|clone|reset)\b[^\n]*(?:head\.sha|head\.ref|head_ref|refs\/pull\/|pull\/)/;

/** How a job holding an identity token could end up running the PR's own code, as far as its steps show. */
function checkPullRequestCheckout(name: string, job: any, problems: string[], unsafe: string[]): void {
	if (typeof job?.uses === 'string') {
		unsafe.push(`that the reusable workflow job "${name}" calls never checks out the pull request's head`);
		return;
	}
	for (const step of asList(job?.steps) as any[]) {
		if (typeof step?.uses === 'string' && /^actions\/checkout@/i.test(step.uses.trim())) {
			for (const field of ['ref', 'repository']) {
				const value = step.with?.[field];
				if (value === undefined) continue;
				if (PULL_REQUEST_HEAD.test(String(value))) {
					problems.push(
						`job "${name}" holds an identity token and checks out the pull request's head (${field}: ${value}), so a ` +
							`PR's code would run with the preview identity`
					);
				} else if (isExpression(value)) {
					unsafe.push(`that job "${name}"'s checkout ${field} (${value}) is not the pull request's head`);
				}
			}
		}
		if (typeof step?.run === 'string' && PR_HEAD_SHELL_CHECKOUT.test(step.run)) {
			problems.push(
				`job "${name}" holds an identity token and a step checks out the pull request's head, so a PR's code would ` +
					'run with the preview identity'
			);
		}
	}
}

function jobCondition(job: any): string {
	return typeof job?.if === 'string'
		? job.if
				.replace(/\$\{\{|\}\}/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
		: '';
}

/**
 * Fork PRs run `pull_request_target` with the base repository's identity, and no token claim names the head repository,
 * so a job's condition is the only gate. Only a whole `&&` term that admits same-repository pull requests counts, or a
 * needed job with one when the condition has no status function: any of them, `success()` included, lets a job run
 * past a needed job being skipped.
 */
function excludesForks(name: string, jobs: Record<string, any>, seen = new Set<string>()): boolean {
	if (seen.has(name)) return false;
	seen.add(name);
	const condition = jobCondition(jobs[name]);
	if (conjuncts(withoutEnclosingParentheses(condition))?.some((term) => SAME_REPOSITORY_TERM.test(term))) return true;
	if (/\b(?:always|failure|cancelled|success)\s*\(/i.test(condition)) return false;
	return asList(jobs[name]?.needs).some((needed) => excludesForks(String(needed), jobs, seen));
}

function checkSameRepositoryCondition(
	name: string,
	jobs: Record<string, any>,
	problems: string[],
	unsafe: string[]
): void {
	if (excludesForks(name, jobs)) return;
	const condition = jobCondition(jobs[name]);
	if (/head\.repo/.test(condition) || asList(jobs[name]?.needs).length > 0) {
		unsafe.push(`that job "${name}" excludes fork pull requests`);
		return;
	}
	problems.push(
		`job "${name}" runs for pull requests from forks: add \`if: github.event.pull_request.head.repo.full_name == ` +
			'github.repository` to it'
	);
}

/**
 * Checks a `pull_request_target` preview workflow against the policies `enable_previews` writes: what can never match
 * them is a problem, and so is what would hand a fork, or a PR's own code, the preview identity.
 */
export function checkPreviewWorkflowFile(
	content: string,
	branch: string,
	environment: string,
	cleanupEnvironment: string
): WorkflowCheck {
	const problems: string[] = [];
	const unverified: string[] = [];
	const unsafe: string[] = [];
	const { workflow, error } = parseWorkflow(content);
	if (error) return { problems: [error], unverified, unsafe };
	const { names, config } = triggerEvents(workflow?.on);
	if (!names.includes('pull_request_target')) {
		problems.push(`it has no pull_request_target trigger, so no run's token carries event_name pull_request_target`);
	} else {
		const filter = config.pull_request_target;
		const branches = asList(filter?.branches);
		if (branches.length > 0 && !branches.includes(branch)) {
			if (branches.some((entry) => isExpression(entry) || /[*?[!+]/.test(String(entry)))) {
				unverified.push(`that ${branches.join(', ')} matches "${branch}"`);
			} else {
				problems.push(`it runs only for pull requests into ${branches.join(', ')}, not "${branch}"`);
			}
		}
		if (asList(filter?.['branches-ignore']).includes(branch)) {
			problems.push(`its branches-ignore filter leaves out pull requests into "${branch}"`);
		}
	}
	checkEnvironmentJobs(workflow, environment, problems, unverified);
	const jobs: Record<string, any> = workflow?.jobs ?? {};
	for (const [name, job] of Object.entries<any>(jobs)) {
		const environmentOfJob = environmentName(job);
		if (environmentOfJob === cleanupEnvironment && !grantsIdToken(job, workflow) && typeof job?.uses !== 'string') {
			problems.push(`job "${name}" runs in "${cleanupEnvironment}" without \`permissions: id-token: write\``);
		}
		if (!grantsIdToken(job, workflow) && typeof job?.uses !== 'string') continue;
		checkPullRequestCheckout(name, job, problems, unsafe);
		checkSameRepositoryCondition(name, jobs, problems, unsafe);
	}
	return { problems, unverified, unsafe };
}

export interface DesiredRecords {
	role: DesiredRole;
	user: DesiredUser;
	policy: DesiredPolicy;
}

export type { Reconcile };

export interface ReconcilePlan {
	role: Reconcile;
	user: Reconcile;
	policy: Reconcile;
	conflicts: string[];
}

/** Why the exchange would refuse the runs `wanted` is for, because of a policy already there. */
function rivalPolicyProblem(policies: any[], wanted: DesiredPolicy): string | undefined {
	const rival = policies.find(
		(policy) =>
			policy?.id !== wanted.id &&
			policy?.enabled !== false &&
			policy?.exchangeable !== false &&
			policiesOverlap(policy, wanted) &&
			!sameAuthority(policy, wanted)
	);
	if (!rival) return undefined;
	return (
		`Trust policy "${rival.id}" can match the same runs as user "${rival.user}", and the exchange refuses a run two ` +
		'policies give different users or operations. Give this component its own workflow (workflow=) or ' +
		'environment (environment=), or drop that policy if this identity should deploy from those runs instead.'
	);
}

export function planReconcile(
	existing: { roles: any[]; users: any[]; policies: any[] },
	desired: DesiredRecords
): ReconcilePlan {
	const plan = planIdentityReconcile(
		existing,
		{ role: desired.role, user: desired.user, policies: [desired.policy] },
		(id) => `If it should be replaced, drop it with \`harper drop_oidc_trust id=${id}\` and run setup again.`
	);
	const rival = rivalPolicyProblem(existing.policies, desired.policy);
	if (rival) plan.conflicts.push(rival);
	return { role: plan.role, user: plan.user, policy: plan.policies[0], conflicts: plan.conflicts };
}

interface RepositoryInfo {
	id: string;
	fullName: string;
	defaultBranch?: string;
	private?: boolean;
}

function parseRepositoryResponse(body: unknown): RepositoryInfo | undefined {
	const data = body as any;
	if (!Number.isSafeInteger(data?.id) || data.id <= 0 || typeof data?.full_name !== 'string') return undefined;
	return {
		id: String(data.id),
		fullName: data.full_name,
		defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : undefined,
		private: typeof data.private === 'boolean' ? data.private : undefined,
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
			// GitHub refuses a request with no User-Agent; Node's default (`node`) satisfies it, but don't rely on that.
			headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'harper-cli' },
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
		} catch {}
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

export type VariableState =
	{ state: 'absent' } | { state: 'set'; value: string } | { state: 'unknown'; reason: string };

function readGithubVariable(repository: string, name: string): VariableState {
	const result = spawnSync(
		'gh',
		['api', '--hostname', 'github.com', `repos/${repository}/actions/variables/${name}`, '--jq', '.value'],
		{ encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	if (result.error) {
		return {
			state: 'unknown',
			reason: (result.error as any).code === 'ENOENT' ? 'the gh CLI is not installed' : result.error.message,
		};
	}
	if (result.status === 0) return { state: 'set', value: result.stdout.trim() };
	if (/HTTP 404/.test(result.stderr)) return { state: 'absent' };
	return { state: 'unknown', reason: result.stderr.trim() || `gh exited with ${result.status}` };
}

/** A target can carry `user:password@`, with or without a scheme; the value is printed, so that part is dropped. */
export function withoutCredentials(value: string): string {
	return value.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^/?#@]*@/i, '$1');
}

/**
 * Like the cluster records, the variable is only created: one that already points at another cluster
 * is how this repository deploys today, and replacing it would move every run of every workflow that
 * reads it. An unreadable variable is left alone too, since it may hold a value.
 */
export function variableAction(current: VariableState, audience: string): 'keep' | 'set' | 'conflict' | 'unknown' {
	if (current.state === 'absent') return 'set';
	if (current.state === 'unknown') return 'unknown';
	let normalized: string | undefined;
	try {
		normalized = normalizeTarget(current.value);
	} catch {}
	return normalized === audience ? 'keep' : 'conflict';
}

/** POST only creates (`gh variable set` would replace), so a variable written since the read is not overwritten. */
function createGithubVariable(repository: string, name: string, value: string): { ok: boolean; reason?: string } {
	const result = spawnSync(
		'gh',
		[
			'api',
			'--hostname',
			'github.com',
			'-X',
			'POST',
			`repos/${repository}/actions/variables`,
			'-f',
			`name=${name}`,
			'-f',
			`value=${value}`,
		],
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

/**
 * The target the setup operations go to, from the response to a first operation sent there. A target from a saved
 * login can change if someone runs `harper login` during setup, so it is pinned; an explicit or environment target
 * can't, and pinning it would drop credentials in its userinfo.
 */
export async function resolveSetupTarget(
	transport: any,
	probe: Record<string, unknown>
): Promise<{ response: any; audience: string }> {
	const response: any = await cliOperations({ ...transport, ...probe }, true);
	const resolvedTarget: string | undefined = response?.resolvedTarget;
	if (!resolvedTarget) {
		throw cliError(
			'GitHub Actions setup needs a remote cluster: pass target=<url>, set HARPER_CLI_TARGET, or run `harper login <url>` first.'
		);
	}
	if (!transport.target && !process.env.HARPER_CLI_TARGET && !process.env.CLI_TARGET) {
		transport.target = resolvedTarget;
	}
	return { response, audience: normalizeTarget(resolvedTarget) };
}

export interface GithubRepository {
	repository: string;
	/** As GitHub spells it, which is what workflow_ref carries; the name as given when it was not looked up. */
	fullName: string;
	repositoryId: string;
	defaultBranch?: string;
	private?: boolean;
	lookedUp: boolean;
}

export async function resolveGithubRepository(
	req: any,
	interactive: boolean,
	notes: string[]
): Promise<GithubRepository> {
	const repository = await resolveRepository(req, interactive);
	// Looked up even when repository_id= is given: GitHub's spelling of the name is what workflow_ref
	// carries, and the claim is compared exactly.
	const info = await lookupRepository(repository);
	const repositoryId = await resolveRepositoryId(req, info, interactive);
	if (info && info.id !== repositoryId) {
		throw cliError(`${info.fullName} has id ${info.id}, not ${repositoryId}.`);
	}
	const fullName = info?.fullName ?? repository;
	if (!info) {
		notes.push(
			`The repository name was not looked up, so its casing was not verified: workflow_ref is compared exactly, ` +
				`so "${fullName}" must be spelled as GitHub spells it.`
		);
	}
	return {
		repository,
		fullName,
		repositoryId,
		defaultBranch: info?.defaultBranch,
		private: info?.private,
		lookedUp: info !== undefined,
	};
}

/**
 * The workflow file as this checkout has it, when the checkout is of `repository`: a workflow file is only evidence
 * about the repository it was checked out from. Undefined, with a note saying why, otherwise.
 */
export function readCheckoutWorkflow(
	repository: GithubRepository,
	workflow: string,
	notes: string[]
): { path: string; content?: string } | undefined {
	let checkoutRepository: string | undefined;
	try {
		checkoutRepository = resolveGitRepo();
	} catch {}
	const isTargetCheckout = [repository.fullName, repository.repository].some(
		(name) => checkoutRepository?.toLowerCase() === name.toLowerCase()
	);
	if (!isTargetCheckout) {
		notes.push(
			`This checkout is ${checkoutRepository ?? 'not a GitHub repository'}, not ${repository.fullName}, so ${workflow} was not checked.`
		);
		return undefined;
	}
	const path = join(gitTopLevel(), workflow);
	if (!existsSync(path)) return { path };
	try {
		return { path, content: readFileSync(path, 'utf8') };
	} catch (error) {
		throw cliError(`Couldn't read ${workflow}: ${(error as Error).message}`);
	}
}

/** Sets a repository variable to the cluster's target unless it already names one; throws, after the cluster part, when it can't. */
export function setupGithubVariable(fullName: string, name: string, audience: string): void {
	const setCommand = `  gh variable set ${name} --repo ${fullName} --body ${audience}`;
	let current = readGithubVariable(fullName, name);
	let action = variableAction(current, audience);
	let variableWrite: { ok: boolean; reason?: string } | undefined;
	if (action === 'set') {
		variableWrite = createGithubVariable(fullName, name, audience);
		if (!variableWrite.ok) {
			// Someone may have created it since the read; judge what is there now rather than the failure.
			const now = readGithubVariable(fullName, name);
			if (now.state === 'set') {
				current = now;
				action = variableAction(now, audience);
			}
		}
	}
	if (action === 'keep') {
		console.log(chalk.green(`✓ The ${name} variable on ${fullName} is already ${audience}.`));
		return;
	}
	if (action === 'conflict') {
		throw cliError(
			`The cluster is set up, but the ${name} variable on ${fullName} is ` +
				`${withoutCredentials((current as { value: string }).value)}, so its workflows deploy there; setup left it as it is. ` +
				`To deploy to ${audience} instead, set it with:\n${setCommand}`
		);
	}
	const variable = variableWrite ?? { ok: false, reason: (current as { reason: string }).reason };
	if (!variable.ok) {
		throw cliError(
			`The cluster is set up, but the ${name} repository variable was not set (${variable.reason}). Set it with:\n` +
				setCommand
		);
	}
	console.log(chalk.green(`✓ Set the ${name} variable on ${fullName} to ${audience}.`));
}

export async function setupGithubActions(req: any, transport: any, component: string): Promise<void> {
	const interactive = Boolean(process.stdin.isTTY);
	const names = deriveCiNames(component);

	const { response: initial, audience } = await resolveSetupTarget(transport, { operation: 'list_oidc_trust' });
	const notes: string[] = [];
	const repository = await resolveGithubRepository(req, interactive, notes);
	const { fullName, repositoryId } = repository;
	const workflow = canonicalWorkflowPath(rawStringArg(req, 'workflow') ?? DEFAULT_WORKFLOW);
	const branch = rawStringArg(req, 'branch') ?? DEFAULT_BRANCH;
	const environment = rawStringArg(req, 'environment') ?? DEFAULT_ENVIRONMENT;

	if (repository.defaultBranch && repository.defaultBranch !== branch) {
		notes.push(`The repository's default branch is "${repository.defaultBranch}"; the policy pins "${branch}".`);
	}
	const checkout = readCheckoutWorkflow(repository, workflow, notes);
	if (checkout?.content !== undefined) {
		const check = checkWorkflowFile(checkout.content, branch, environment);
		if (check.problems.length > 0) {
			throw cliError(
				`${workflow} cannot match the trust policy: ${check.problems.join('; ')}. Pass branch= or environment= to ` +
					'match the workflow, or change the workflow.'
			);
		}
		for (const item of check.unverified) notes.push(`Not verified from ${workflow}: ${item}.`);
	} else if (checkout) {
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
	const policiesNow = async () =>
		asList(((await cliOperations({ ...transport, operation: 'list_oidc_trust' }, true)) as any)?.policies);
	const policyNow = async () => (await policiesNow()).find((policy: any) => policy?.id === names.policy);
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
		// add_oidc_trust replaces a policy, so one another super user creates (enabled or not) since the
		// preflight would be overwritten. Checking again narrows that window to one round trip. An existing
		// policy is never written, so this can't undo a disable or a drop.
		const policies = await policiesNow();
		if (policies.some((policy: any) => policy?.id === names.policy)) {
			throw cliError(`Trust policy "${names.policy}" was created while setup ran. Run setup again to check it.`);
		}
		const rival = rivalPolicyProblem(policies, desired.policy);
		if (rival) throw cliError(`${rival} Run setup again to check it.`);
		const response: any = await cliOperations({ ...transport, operation: 'add_oidc_trust', ...desired.policy }, true);
		if (response?.warning) console.log(chalk.yellow(response.warning));
		created.push(`trust policy ${names.policy}`);
	}

	const stored: any = await policyNow();
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
				`run ${CI_DEPLOY_OPERATIONS.slice(0, -1).join(', ')} and ${CI_DEPLOY_OPERATIONS.at(-1)} — for any component on this cluster, not only ${component}.`
		)
	);
	for (const note of notes) console.log(chalk.yellow(`  ${note}`));
	console.log(
		chalk.gray(
			`  To revoke: harper drop_oidc_trust id=${names.policy} stops new runs; ` +
				`harper alter_user username=${names.user} active=false also stops a token already issued (it lasts an hour).`
		)
	);

	setupGithubVariable(fullName, TARGET_VARIABLE, audience);
}
