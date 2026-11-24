// The GitHub Actions event policy `harper preview setup` creates for a public repository: from December 2, 2026,
// GitHub blocks `pull_request_target` there unless an Active event policy allows it for the workflow, and every Active
// event policy that applies to the workflow has to allow it.

import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import _micromatch from 'micromatch';
import { promptYesNo } from '../utility/interactivePrompts.ts';
import { workflowTriggerEvents, type GithubRepository } from './deploySetupGithubActions.ts';

const { isMatch } = _micromatch;

export const ACTIONS_POLICY_DOCS = 'https://docs.github.com/actions/how-tos/administer/control-workflow-execution';
const API_VERSION_HEADER = 'X-GitHub-Api-Version: 2026-03-10';
const PULL_REQUEST_TARGET = 'pull_request_target';
const GH_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const PATTERN_CHARACTERS = /[*?[\]{}()!+@]/;

export interface ActionsPolicyBody {
	name: string;
	enforcement: 'active';
	conditions: { workflow_path: { include: string[]; exclude: string[] } };
	rules: { type: 'restrict_action_events'; parameters: { allowed_events: string[] } }[];
}

type GhResult = { stdout: string } | { reason: string; status?: number };

function gh(args: string[], input?: string): GhResult {
	const result = spawnSync('gh', ['api', '--hostname', 'github.com', ...args], {
		encoding: 'utf8',
		timeout: GH_TIMEOUT_MS,
		input,
		stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
	});
	if (result.error) {
		const reason = (result.error as any).code === 'ENOENT' ? 'the gh CLI is not installed' : result.error.message;
		return { reason };
	}
	if (result.status !== 0) {
		return {
			status: Number(/HTTP (\d{3})/.exec(result.stderr)?.[1]) || undefined,
			reason: result.stderr.trim().split('\n')[0] || `gh exited with ${result.status ?? result.signal}`,
		};
	}
	return { stdout: result.stdout };
}

function policyFailure(result: { reason: string; status?: number }): string {
	return result.status === 403 || result.status === 404
		? `${result.reason}, which GitHub answers to an account that is not an admin of the repository`
		: result.reason;
}

function listActionsPolicies(repository: string): { policies: any[] } | { reason: string } {
	const policies: any[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const result = gh([
			'-H',
			API_VERSION_HEADER,
			`repos/${repository}/actions/policies?per_page=${PAGE_SIZE}&page=${page}`,
		]);
		if ('reason' in result) return { reason: policyFailure(result) };
		let body: any;
		try {
			body = JSON.parse(result.stdout);
		} catch {
			return { reason: 'GitHub answered with something other than JSON' };
		}
		if (!Array.isArray(body?.policies)) return { reason: 'GitHub answered without a list of policies' };
		policies.push(...body.policies);
		// A page can come back shorter than asked, so the total decides when GitHub gives one.
		const total = Number.isSafeInteger(body.total_count) ? body.total_count : undefined;
		if (total === undefined ? body.policies.length < PAGE_SIZE : policies.length >= total) return { policies };
		if (body.policies.length === 0) return { reason: `GitHub listed ${policies.length} of ${total} policies` };
	}
	return { reason: `it lists more than ${MAX_PAGES * PAGE_SIZE} policies` };
}

function readWorkflowOnBranch(
	repository: string,
	workflow: string,
	branch: string
): { content: string } | { absent: true } | { reason: string } {
	const path = workflow.split('/').map(encodeURIComponent).join('/');
	const result = gh([
		'-H',
		'Accept: application/vnd.github.raw+json',
		`repos/${repository}/contents/${path}?ref=${encodeURIComponent(branch)}`,
	]);
	if ('stdout' in result) return { content: result.stdout };
	if (result.status === 404) return { absent: true };
	return { reason: result.reason };
}

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const asPath = (pattern: string) => pattern.trim().replace(/^\.?\//, '');

/**
 * A pattern is read with micromatch, which can disagree with GitHub, so it may widen what a policy covers but never
 * narrows it: only the exact path excludes the file.
 */
function coverage(policy: any, workflow: string): 'every' | 'path' | 'pattern' | undefined {
	const paths = policy?.conditions?.workflow_path;
	const matches = (path: string) => PATTERN_CHARACTERS.test(path) && isMatch(workflow, path, { dot: true });
	const exclude = strings(paths?.exclude).map(asPath);
	if (exclude.includes(workflow)) return undefined;
	const include = strings(paths?.include).map(asPath);
	const covered =
		include.length === 0 || include.includes('~ALL')
			? 'every'
			: include.includes(workflow)
				? 'path'
				: include.some(matches)
					? 'pattern'
					: undefined;
	return covered && exclude.some(matches) ? 'pattern' : covered;
}

const isRepositoryLevel = (policy: any) => (policy?.source_type ?? 'Repository') === 'Repository';

function policyLabel(policy: any): string {
	if (isRepositoryLevel(policy)) return `policy "${policy?.name}"`;
	return `${String(policy.source_type).toLowerCase()} policy "${policy?.name}"${policy.source ? ` (${policy.source})` : ''}`;
}

type PolicyPlan =
	| { action: 'create'; notes: string[] }
	| { action: 'allowed'; by: string[]; notes: string[] }
	| { action: 'conflict'; problems: string[] }
	| { action: 'unknown'; reason: string };

/**
 * Only an Active policy allows or blocks, and an event runs only if every Active event policy covering the file lists
 * it. One that covers the file only through a pattern can block, and can leave other events out, but never counts as
 * allowing. A policy someone made for the file and turned off is theirs to change, so setup adds none beside it.
 */
function planActionsPolicy(policies: any[], repository: string, workflow: string, events: string[]): PolicyPlan {
	const blocking: string[] = [];
	const inactive: string[] = [];
	const unreadable: string[] = [];
	const allowing: string[] = [];
	const notes: string[] = [];
	for (const policy of policies) {
		const covers = coverage(policy, workflow);
		if (!covers) continue;
		const active = policy?.enforcement === 'active';
		const ownedForFile = isRepositoryLevel(policy) && covers === 'path';
		if (!Array.isArray(policy?.rules)) {
			// Listed without its rules, and maybe without the conditions that would show it is for another file.
			if (active || ownedForFile || (isRepositoryLevel(policy) && !policy?.conditions)) {
				unreadable.push(policyLabel(policy));
			}
			continue;
		}
		const eventRules = policy.rules.filter((rule: any) => rule?.type === 'restrict_action_events');
		if (eventRules.length === 0) continue;
		const allows = (event: string) =>
			eventRules.every((rule: any) => strings(rule?.parameters?.allowed_events).includes(event));
		const through = covers === 'pattern' ? ', through a pattern,' : '';
		if (active && !allows(PULL_REQUEST_TARGET)) {
			blocking.push(
				isRepositoryLevel(policy)
					? `Policy "${policy.name}" is Active for ${workflow}${through} and its Restrict events leaves out ` +
							`pull_request_target: add pull_request_target to its allowed events${covers === 'path' ? '' : `, or exclude ${workflow} from it`}.`
					: `The ${policyLabel(policy)} is Active for ${workflow}${through} and its Restrict events leaves out ` +
							`pull_request_target: its owner has to allow pull_request_target for ${repository} and ${workflow}.`
			);
		} else if (active) {
			if (covers !== 'pattern') allowing.push(policyLabel(policy));
			const leftOut = events.filter((event) => !allows(event));
			if (leftOut.length > 0) {
				notes.push(
					`The ${policyLabel(policy)}${through} leaves out ${leftOut.join(', ')}, which ${workflow} also runs on, so ` +
						'those runs are blocked; add them to its allowed events if they should run.'
				);
			}
		} else if (ownedForFile) {
			inactive.push(
				`Policy "${policy.name}" targets ${workflow} but is ${policy.enforcement === 'evaluate' ? 'in evaluate mode' : 'disabled'}, ` +
					`so it allows nothing. Make it Active with ${events.join(', ')} among its allowed events, or delete it and ` +
					'run setup again.'
			);
		}
	}
	if (blocking.length > 0) return { action: 'conflict', problems: blocking };
	if (unreadable.length > 0) {
		return { action: 'unknown', reason: `GitHub did not list the rules of ${unreadable.join(', ')}` };
	}
	if (allowing.length > 0) return { action: 'allowed', by: allowing, notes };
	if (inactive.length > 0) return { action: 'conflict', problems: inactive };
	return { action: 'create', notes };
}

function previewActionsPolicy(workflow: string, events: string[]): ActionsPolicyBody {
	return {
		name: `Allow Harper previews (${posix.basename(workflow)})`,
		enforcement: 'active',
		conditions: { workflow_path: { include: [workflow], exclude: [] } },
		rules: [{ type: 'restrict_action_events', parameters: { allowed_events: events } }],
	};
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function createPolicyCommand(repository: string, body: ActionsPolicyBody): string {
	return (
		`printf '%s' ${shellQuote(JSON.stringify(body))} | gh api --hostname github.com --method POST ` +
		`-H ${shellQuote(API_VERSION_HEADER)} repos/${repository}/actions/policies --input -`
	);
}

function blockNotice(repository: string, isPrivate: boolean | undefined): string {
	return (
		`${isPrivate === false ? `${repository} is public:` : `If ${repository} is public:`} from December 2, 2026, ` +
		'GitHub Actions blocks pull_request_target in public repositories unless an Actions event policy allows it, ' +
		'and previews stop.'
	);
}

function manualSteps(repository: string, workflow: string): string {
	return (
		`  In the repository's Settings > Actions > Policies, make sure an Active policy targets only ${workflow} ` +
		'and its Restrict events allows pull_request_target, plus any other event that workflow runs on. ' +
		`An organization policy for it must target ${repository} too, and an organization or enterprise policy ` +
		'can still block it: Policy insights shows what was blocked.\n' +
		`  ${ACTIONS_POLICY_DOCS}`
	);
}

function printFallback(repository: GithubRepository, workflow: string, why: string, body?: ActionsPolicyBody): void {
	const lines = [`! ${blockNotice(repository.fullName, repository.private)}${why ? ` ${why}` : ''}`];
	lines.push(manualSteps(repository.fullName, workflow));
	if (body) {
		lines.push(`  Or, as an admin of ${repository.fullName}:\n  ${createPolicyCommand(repository.fullName, body)}`);
	}
	console.log(chalk.yellow(lines.join('\n')));
}

function printNotes(notes: string[]): void {
	for (const note of notes) console.log(chalk.yellow(`  ${note}`));
}

function printPlan(repository: GithubRepository, workflow: string, plan: PolicyPlan, body: ActionsPolicyBody): void {
	if (plan.action === 'allowed') {
		console.log(
			chalk.green(
				`✓ The Actions event ${plan.by.join(', ')} on ${repository.fullName} already allows pull_request_target for ${workflow}.`
			)
		);
		printNotes(plan.notes);
	} else if (plan.action === 'conflict') {
		console.log(
			chalk.yellow(
				`! ${blockNotice(repository.fullName, repository.private)} Setup created no policy:\n` +
					plan.problems.map((problem) => `  - ${problem}`).join('\n') +
					`\n  Policy insights, under Settings > Actions > Policies, shows what was blocked. ${ACTIONS_POLICY_DOCS}`
			)
		);
	} else if (plan.action === 'unknown') {
		printFallback(repository, workflow, `Setup created none: ${plan.reason}.`, body);
	}
}

const normalized = (content: string) => content.replace(/\r\n/g, '\n');

function sameEvents(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((event) => right.includes(event));
}

export interface ActionsPolicySetup {
	repository: GithubRepository;
	workflow: string;
	/** The workflow setup checked in the checkout, or the starter it is about to write. */
	checkoutWorkflow?: string;
	workflowProblems: (content: string) => string[];
	/** The policy lowers GitHub's default protection for the file, so creating it takes a yes. */
	consent?: boolean;
	interactive: boolean;
}

/**
 * `pull_request_target` runs the copy on the default branch, so the policy allows that copy's events, and only for a
 * copy setup can vouch for: the one it checked here, or one that passes the same check. When the default branch has
 * no copy yet, the one here is what will run once committed.
 */
function verifiedEvents(setup: ActionsPolicySetup): { events: string[] } | { reason: string } {
	const { repository, workflow, checkoutWorkflow } = setup;
	if (PATTERN_CHARACTERS.test(workflow)) {
		return {
			reason: `Setup created none: a policy reads ${workflow} as a pattern, which can take in other workflows.`,
		};
	}
	const checkoutEvents = checkoutWorkflow === undefined ? undefined : workflowTriggerEvents(checkoutWorkflow);
	if (!checkoutEvents?.includes(PULL_REQUEST_TARGET)) {
		return {
			reason: `Setup created none: it did not read ${workflow} here, and the policy has to allow every event that file runs on.`,
		};
	}
	const branch = repository.defaultBranch;
	if (!branch) return { reason: `Setup created none: it did not learn ${repository.fullName}'s default branch.` };
	const onBranch = readWorkflowOnBranch(repository.fullName, workflow, branch);
	if ('reason' in onBranch) {
		return { reason: `Setup could not read ${workflow} on ${branch} (${onBranch.reason}), so it created none.` };
	}
	if ('absent' in onBranch) return { events: checkoutEvents };
	const commitAndRerun = `Make the copy here and the one on ${branch} agree, then run setup again.`;
	if (normalized(onBranch.content) !== normalized(checkoutWorkflow)) {
		let problems: string[];
		try {
			problems = setup.workflowProblems(onBranch.content);
		} catch (error) {
			problems = [(error as Error).message];
		}
		if (problems.length > 0) {
			return {
				reason: `Setup created none: ${workflow} on ${branch} is not the copy here, and setup cannot vouch for it: ${problems.join('; ')}. ${commitAndRerun}`,
			};
		}
	}
	const live = workflowTriggerEvents(onBranch.content);
	if (!live || !sameEvents(live, checkoutEvents)) {
		return {
			reason:
				`Setup created none: ${workflow} on ${branch} runs on ${live?.join(', ') ?? 'events setup cannot read'}, and ` +
				`the copy here on ${checkoutEvents.join(', ')}. ${commitAndRerun}`,
		};
	}
	return { events: live };
}

/** Runs before anything changes, and returns the policy to create once previews are enabled. */
export async function prepareActionsPolicy(setup: ActionsPolicySetup): Promise<ActionsPolicyBody | undefined> {
	const { repository, workflow } = setup;
	if (repository.private === true) return undefined;
	if (repository.private !== false) {
		printFallback(repository, workflow, '');
		return undefined;
	}
	const verified = verifiedEvents(setup);
	if ('reason' in verified) {
		printFallback(repository, workflow, verified.reason);
		return undefined;
	}
	const body = previewActionsPolicy(workflow, verified.events);
	const listed = listActionsPolicies(repository.fullName);
	if ('reason' in listed) {
		printFallback(
			repository,
			workflow,
			`Setup could not read its Actions policies (${listed.reason}), so it created none.`,
			body
		);
		return undefined;
	}
	const plan = planActionsPolicy(listed.policies, repository.fullName, workflow, verified.events);
	if (plan.action !== 'create') {
		printPlan(repository, workflow, plan, body);
		return undefined;
	}
	printNotes(plan.notes);
	if (repository.canAdminister === false) {
		printFallback(
			repository,
			workflow,
			`Setup created none: the gh account is not an admin of ${repository.fullName}, which a policy takes.`,
			body
		);
		return undefined;
	}
	let consent = setup.consent;
	if (consent === undefined && setup.interactive) {
		consent = await promptYesNo({
			message:
				`${repository.fullName} is public, and from December 2, 2026 GitHub blocks pull_request_target there unless an ` +
				`Actions event policy allows it. Create one that lets only ${verified.events.join(', ')} start ${workflow}?`,
			default: true,
		});
	}
	if (consent !== true) {
		printFallback(
			repository,
			workflow,
			setup.consent === undefined && !setup.interactive
				? 'Setup creates the policy with actions_policy=true.'
				: 'Setup did not create one.',
			body
		);
		return undefined;
	}
	console.log(chalk.gray(`Setup will create the Actions event policy "${body.name}" once previews are enabled.`));
	return body;
}

/** Create-only, after the cluster part; a failure prints the manual steps rather than failing setup. */
export function createActionsPolicy(repository: GithubRepository, workflow: string, body: ActionsPolicyBody): void {
	const events = body.rules[0].parameters.allowed_events;
	const replan = (): PolicyPlan | { listFailure: string } => {
		const listed = listActionsPolicies(repository.fullName);
		if ('reason' in listed) return { listFailure: listed.reason };
		return planActionsPolicy(listed.policies, repository.fullName, workflow, events);
	};
	const before = replan();
	if ('listFailure' in before) {
		const why = `Setup could not read its Actions policies again (${before.listFailure}), so it created none.`;
		printFallback(repository, workflow, why, body);
		return;
	}
	if (before.action !== 'create') {
		printPlan(repository, workflow, before, body);
		return;
	}
	const result = gh(
		['-H', API_VERSION_HEADER, '--method', 'POST', `repos/${repository.fullName}/actions/policies`, '--input', '-'],
		JSON.stringify(body)
	);
	if ('stdout' in result) {
		console.log(
			chalk.green(
				`✓ Created the Actions event policy "${body.name}" on ${repository.fullName}: only ${events.join(', ')} can start ${workflow}.`
			) +
				chalk.gray(
					'\n  Another Active policy, here or in an organization or enterprise, can still block it: Policy insights, ' +
						'under Settings > Actions > Policies, shows what was blocked.'
				)
		);
		return;
	}
	// A request that timed out may still have created it.
	const after = replan();
	if (!('listFailure' in after) && after.action === 'allowed') {
		printPlan(repository, workflow, after, body);
		return;
	}
	const unverified =
		'listFailure' in after || after.action !== 'create'
			? ' It may have been created anyway: look in Settings > Actions > Policies first.'
			: '';
	printFallback(
		repository,
		workflow,
		`Setup could not create the policy (${policyFailure(result)}).${unverified}`,
		body
	);
}
