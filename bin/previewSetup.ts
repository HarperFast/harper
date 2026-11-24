import chalk from 'chalk';
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { prompts } from '../utility/interactivePrompts.ts';
import { cliOperations, transportContext } from './cliOperations.ts';
import {
	assertGithubVariableSettable,
	checkPreviewWorkflowFile,
	rawStringArg,
	readCheckoutWorkflow,
	resolveGithubRepository,
	resolveSetupTarget,
	setupGithubVariable,
} from './deploySetupGithubActions.ts';
import { ACTIONS_POLICY_DOCS, createActionsPolicy, prepareActionsPolicy } from './actionsEventPolicy.ts';
import { fetchSecretsPublicKey, resolveDeployToken, sealDeployCredential } from './deploySetup.ts';
import {
	CI_PREVIEW_OPERATIONS,
	PREVIEW_CLEANUP_ENVIRONMENT,
	PREVIEW_ENVIRONMENT,
	PREVIEW_TARGET_VARIABLE,
	PREVIEW_WORKFLOW,
	canonicalWorkflowPath,
	defaultPreviewDomain,
	derivePreviewNames,
} from '../utility/previewIdentity.ts';

export { ACTIONS_POLICY_DOCS };

function usageError(message: string): Error {
	return Object.assign(new Error(message), { statusCode: 400 });
}

export interface StarterWorkflowOptions {
	app: string;
	branch: string;
	environment?: string;
	/** Passed to the action only when it is not the target's default. */
	domain?: string;
	credential?: boolean;
	shared?: boolean;
}

/**
 * Pinned by commit, so a moved tag cannot change what runs with the preview identity. Setup's workflow check does not
 * read inside an action, so keeping a PR's code away from that identity rests on this version never checking out the
 * PR's head: check that again before moving the pin.
 */
const DEPLOY_ACTION = 'HarperFast/deploy-action@a4a8af4e47add946657310b546f9e483d44b5cc5 # v1.0.1';

/**
 * The smallest workflow the preview policies match. It runs from the default branch and
 * never checks out the PR, so a PR cannot change what runs with the identity, and the cluster fetches the PR's commit
 * itself. Cleanup runs in its own environment, which carries no required reviewers, so a closure never waits for an
 * approval. The action deploys only while the PR is open at its commit, and drops what it deployed if the PR closed
 * meanwhile. Both jobs stay skipped until setup has set the target variable, so a copy committed before setup finishes
 * runs nothing.
 */
export function starterPreviewWorkflow({
	app,
	branch,
	environment = PREVIEW_ENVIRONMENT,
	domain,
	credential,
	shared,
}: StarterWorkflowOptions): string {
	const sameRepository = 'github.event.pull_request.head.repo.full_name == github.repository';
	const job = (name: string, condition: string, jobEnvironment: string, step: string, extra: string[]) => [
		`  ${name}:`,
		`    if: vars.${PREVIEW_TARGET_VARIABLE} != '' && ${condition} && ${sameRepository}`,
		'    runs-on: ubuntu-latest',
		`    environment: ${jobEnvironment}`,
		'    permissions:',
		'      id-token: write',
		'      pull-requests: write',
		'      deployments: write',
		...extra,
		'    steps:',
		`      - name: ${step}`,
		`        uses: ${DEPLOY_ACTION}`,
		'        with:',
		`          target: \${{ vars.${PREVIEW_TARGET_VARIABLE} }}`,
		`          app: ${JSON.stringify(app)}`,
		'          preview: true',
	];
	return [
		'# Written by `harper preview setup`.',
		`# From December 2, 2026, in a public repository, pull_request_target runs only if an Actions event policy targeting this repository and this file allows it. ${ACTIONS_POLICY_DOCS}`,
		'name: Preview',
		'on:',
		'  pull_request_target:',
		'    types: [opened, reopened, synchronize, closed]',
		`    branches: [${JSON.stringify(branch)}]`,
		'permissions: {}',
		'jobs:',
		...job('deploy', "github.event.action != 'closed'", environment, 'Deploy the preview', [
			'    concurrency:',
			'      group: harper-preview-${{ github.event.pull_request.number }}',
		]),
		...(credential ? ['          credential: true'] : []),
		...(domain ? [`          domain: ${JSON.stringify(domain)}`] : []),
		...(shared ? ['          branched_databases: false'] : []),
		...job('cleanup', "github.event.action == 'closed'", PREVIEW_CLEANUP_ENVIRONMENT, 'Remove the preview', []),
		'',
	].join('\n');
}

function previewApp(args: Record<string, any>): string {
	const app = rawStringArg(args, 'app');
	if (!app) throw usageError('`app=<component>` names the application to set up previews for, e.g. app=shop');
	derivePreviewNames(app);
	return app;
}

function positiveNumber(args: Record<string, any>, name: string, integer: boolean): number | undefined {
	const raw = rawStringArg(args, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
		throw usageError(`\`${name}=\` must be a positive ${integer ? 'whole number' : 'number'}`);
	}
	return value;
}

export async function previewSetup(args: Record<string, any>): Promise<void> {
	const interactive = Boolean(process.stdin.isTTY);
	const app = previewApp(args);
	const names = derivePreviewNames(app);
	const transport = transportContext(args);
	const { audience } = await resolveSetupTarget(transport, { operation: 'get_preview_policy', app });

	const notes: string[] = [];
	const repository = await resolveGithubRepository(args, interactive, notes);
	const branch = rawStringArg(args, 'branch') ?? repository.defaultBranch ?? 'main';
	if (!rawStringArg(args, 'branch') && !repository.defaultBranch) {
		notes.push(
			`The repository's default branch was not looked up; the policies pin "${branch}" (pass branch= if not).`
		);
	}
	const workflow = canonicalWorkflowPath(rawStringArg(args, 'workflow') ?? PREVIEW_WORKFLOW);
	const environment = rawStringArg(args, 'environment') ?? PREVIEW_ENVIRONMENT;
	const defaultDomain = defaultPreviewDomain(audience);
	const domain = rawStringArg(args, 'domain')?.toLowerCase().replace(/^\./, '') ?? defaultDomain;
	if (!domain) throw usageError('`domain=<preview domain>` is required when the target is not a host name');
	const dataMode = rawStringArg(args, 'dataMode');
	if (dataMode !== undefined && dataMode !== 'branched' && dataMode !== 'shared') {
		throw usageError('`dataMode=` is `branched` (the default: each preview gets its own database branch) or `shared`');
	}
	if (args.actions_policy !== undefined && typeof args.actions_policy !== 'boolean') {
		throw usageError('`actions_policy=` is `true` or `false`');
	}
	const maxPreviews = positiveNumber(args, 'maxPreviews', true);
	const maxTtlDays = positiveNumber(args, 'maxTtlDays', false);

	const checkout = readCheckoutWorkflow(repository, workflow, notes);
	if (checkout?.content !== undefined) {
		const check = checkPreviewWorkflowFile(checkout.content, branch, environment, PREVIEW_CLEANUP_ENVIRONMENT);
		if (check.problems.length > 0) {
			throw usageError(`${workflow} cannot be used for previews: ${check.problems.join('; ')}. Nothing was changed.`);
		}
		const unsafe = check.unsafe ?? [];
		if (unsafe.length > 0 && args.allow_unverified !== true) {
			throw usageError(
				`${workflow} may hand the preview identity to a fork or to a PR's code: setup could not verify ` +
					`${unsafe.join('; ')}. Change the workflow, or pass allow_unverified=true once you have checked it. ` +
					'Nothing was changed.'
			);
		}
		for (const item of [...unsafe, ...check.unverified]) notes.push(`Not verified from ${workflow}: ${item}.`);
	}
	let writeWorkflow = false;
	if (checkout && checkout.content === undefined) {
		writeWorkflow =
			args.write_workflow === true ||
			(args.write_workflow === undefined &&
				interactive &&
				(await prompts.confirm({
					message: `${workflow} does not exist. Write a starter preview workflow?`,
					default: true,
				})));
	}
	const target = new URL(audience);
	if (
		writeWorkflow &&
		target.protocol === 'http:' &&
		!/^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(target.hostname)
	) {
		notes.push(
			`HarperFast/deploy-action, which ${workflow} runs, refuses an http:// target other than a loopback address, so ` +
				`its runs cannot reach ${audience}. Set up previews against the cluster's https:// URL.`
		);
	}
	if ((!checkout || (checkout.content === undefined && !writeWorkflow)) && args.allow_unverified !== true) {
		throw usageError(
			`Setup could not check ${workflow} ${checkout ? 'because it is not in this checkout' : `from a checkout of ${repository.fullName}`}, ` +
				'and the workflow is what keeps forks and PR code away from the preview identity. Run setup from a checkout ' +
				'of the repository, pass write_workflow=true for a starter one, or allow_unverified=true once you have ' +
				'checked it yourself. Nothing was changed.'
		);
	}
	let credential = args.credential === true;
	if (!credential && repository.private && args.credential === undefined) {
		if (interactive) {
			credential = await prompts.confirm({
				message: `${repository.fullName} is private, so the cluster needs a credential to fetch each PR. Set one up now?`,
				default: true,
			});
		} else {
			notes.push(
				`${repository.fullName} is private: the cluster cannot fetch a PR's commit until a credential is set up (credential=true).`
			);
		}
	}
	const starter =
		writeWorkflow && checkout
			? starterPreviewWorkflow({
					app,
					branch,
					environment,
					domain: domain === defaultDomain ? undefined : domain,
					credential,
					shared: dataMode === 'shared',
				})
			: undefined;
	const actionsPolicy = await prepareActionsPolicy({
		repository,
		workflow,
		checkoutWorkflow: starter ?? checkout?.content,
		workflowProblems: (content) => {
			const check = checkPreviewWorkflowFile(content, branch, environment, PREVIEW_CLEANUP_ENVIRONMENT);
			return [...check.problems, ...(check.unsafe ?? [])];
		},
		consent: args.actions_policy,
		interactive,
	});
	assertGithubVariableSettable(repository, PREVIEW_TARGET_VARIABLE, audience, args.allow_unverified === true);
	// Before anything is written: a cluster without secret custody cannot hold the credential.
	const secretsKey = credential ? await fetchSecretsPublicKey(transport) : undefined;
	const token = secretsKey ? await resolveDeployToken(args, 'github') : undefined;
	if (writeWorkflow && checkout) {
		if (existsSync(checkout.path)) {
			throw usageError(`${workflow} appeared while setup ran; run setup again to check it. Nothing was changed.`);
		}
		try {
			mkdirSync(dirname(checkout.path), { recursive: true });
			accessSync(dirname(checkout.path), constants.W_OK);
		} catch (error) {
			throw usageError(`Cannot write ${workflow}: ${(error as Error).message}. Nothing was changed.`);
		}
	}

	const enabled: any = await cliOperations(
		{
			...transport,
			operation: 'enable_previews',
			app,
			repository: repository.fullName,
			repository_id: repository.repositoryId,
			branch,
			audience,
			workflow,
			environment,
			hostSuffix: `.${domain}`,
			...(dataMode && { dataMode }),
			...(maxPreviews !== undefined && { maxPreviews }),
			...(maxTtlDays !== undefined && { maxTtlDays }),
		},
		true
	);
	console.log(chalk.green(`\n✓ ${repository.fullName} can deploy previews of ${app} to ${audience}.`));
	console.log(
		chalk.gray(
			`  ${enabled?.message ?? ''}.\n` +
				`  Runs of ${workflow} on ${branch} for pull_request_target act as ${names.user}: in the ${environment} ` +
				`environment it can run ${CI_PREVIEW_OPERATIONS.join(', ')} for ${names.components} only, as isolated ` +
				`applications under .${domain}; in ${PREVIEW_CLEANUP_ENVIRONMENT}, only drop them.\n` +
				`  To remove it all, previews included: harper preview teardown app=${app}`
		)
	);

	const unfinished: string[] = [];
	if (secretsKey) {
		try {
			const { secretName } = await sealDeployCredential(
				{ ...args, token },
				transport,
				'github',
				names.components,
				secretsKey,
				false
			);
			console.log(
				chalk.green(`✓ Sealed a GitHub credential for every preview of ${app} as secret "${secretName}".`) +
					chalk.gray('\n  `harper preview deploy credential=true` uses it.')
			);
		} catch (error) {
			unfinished.push(
				`The cluster is set up, but the GitHub credential was not sealed (${(error as Error).message}). ` +
					'Run setup again with credential=true to seal it.'
			);
		}
	}
	let workflowWritten = true;
	if (starter && checkout) {
		try {
			writeFileSync(checkout.path, starter, { flag: 'wx' });
			console.log(
				chalk.green(
					`✓ Wrote ${workflow}. Once setup finishes, commit it to ${branch}: pull_request_target runs it from there.`
				)
			);
		} catch (error) {
			workflowWritten = false;
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				try {
					rmSync(checkout.path, { force: true });
				} catch {}
			}
			unfinished.push(
				(error as NodeJS.ErrnoException).code === 'EEXIST'
					? `The cluster is set up, but ${workflow} appeared while setup ran, so setup did not write it. Run setup again to check it.`
					: `The cluster is set up, but ${workflow} was not written (${(error as Error).message}). Run setup again with write_workflow=true to write it.`
			);
		}
	}
	for (const note of notes) console.log(chalk.yellow(`  ${note}`));
	try {
		setupGithubVariable(repository.fullName, PREVIEW_TARGET_VARIABLE, audience);
	} catch (error) {
		unfinished.push((error as Error).message);
	}
	if (actionsPolicy && workflowWritten) createActionsPolicy(repository, workflow, actionsPolicy);
	else if (actionsPolicy) {
		unfinished.push(
			`The Actions event policy was not created, since it allows the events of the ${workflow} setup did not write.`
		);
	}
	if (unfinished.length > 0) {
		if (starter && workflowWritten) {
			unfinished.push(
				`Setup wrote ${workflow}: commit it only once the steps above are done, since its runs fail until then.`
			);
		}
		throw usageError(unfinished.join('\n'));
	}
}

export function formatTeardown(response: any): string {
	const lines = [response?.message ?? 'Disabled previews.'];
	for (const drop of response?.dropped ?? []) {
		const outcome = drop.error ? `failed: ${drop.error}` : drop.componentRemoved ? 'dropped' : 'did not hold it';
		lines.push(`  ${drop.project}: ${drop.node} ${outcome}`);
	}
	if (response?.removed?.length) lines.push(`  Removed ${response.removed.join(', ')}.`);
	if (response?.inProgress?.length) {
		lines.push(
			`  Still deploying when previews were revoked: ${response.inProgress.join(', ')}. If one goes live, it is dropped ` +
				'when it expires, or by `harper preview drop`.'
		);
	}
	lines.push(
		'  The GitHub side stays as it is, including an Actions event policy setup created in a public repository, ' +
			'"Allow Harper previews (<workflow file>)": delete it in the repository\'s Settings > Actions > Policies.'
	);
	return lines.join('\n');
}

export async function previewTeardown(args: Record<string, any>): Promise<string> {
	const app = previewApp(args);
	const response: any = await cliOperations({ ...transportContext(args), operation: 'disable_previews', app }, true);
	return formatTeardown(response);
}
