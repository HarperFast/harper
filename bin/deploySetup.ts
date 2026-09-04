'use strict';

// `harper deploy setup=true` — provision a durable, encrypted credential the cluster uses to fetch
// private deploy sources (a private GitHub repo, or a private npm registry).
//
// The whole point is that the token is sealed *on this machine* with the cluster's public secrets
// key and only the ciphertext is ever transmitted or stored — the cluster (and its logs, its
// operations journal, its replication) never sees the plaintext, and decrypts it only in-memory at
// deploy/rollback time. Because the token is durable (unlike a CI `GITHUB_TOKEN`, which dies at job
// end), a re-resolve rollback works for as long as the token is valid.
//
// Flow:
//   1. get_secrets_public_key  → the cluster's RSA public key + fingerprint
//   2. source a token          → `gh auth token`, or paste a fine-grained PAT / npm token
//   3. encryptEnvelope(...)     → seal it locally into an `enc:v1:` envelope (pure client-side crypto)
//   4. set_secret {envelope}    → store ciphertext, in the component-scoped tier
//   5. grant_secret            → let this component resolve it (see storeSealedSecret for why it's two calls)
//   6. print the `credentials` reference the deploy should use
//
// Every name this flow derives — the component it grants to, the host it labels the credential with,
// the hdb_secret row it writes — has to match what the deploy will derive from its own request, or it
// seals a credential the deploy cannot use. Those derivations therefore come from
// utility/componentNames.ts, the one module both this client and the server's deploy path use.

import chalk from 'chalk';
import inquirer from 'inquirer';
import { execFileSync } from 'node:child_process';
import { cliOperations, transportContext } from './cliOperations.ts';
import { encryptEnvelope } from '../utility/secretEnvelope.ts';
import { ENV_ENCRYPTED_PREFIX } from '../utility/envFile.ts';
import {
	canonicalProjectName,
	deriveGitSecretName,
	deriveRegistrySecretName,
	directoryProjectName,
	normalizeGitHost,
	projectNameFromPackage,
	GIT_HOST_PATTERN,
	isReservedComponentName,
	PROJECT_NAME_PATTERN,
} from '../utility/componentNames.ts';

// `formatCliError` (bin/harper.ts) prints message-only for an error carrying a numeric `statusCode`
// and keeps the stack for anything else, on the assumption that a stack means a bug. Everything this
// flow throws is a usage or cluster-capability problem the operator can act on, so it gets a code —
// the value only selects the clean formatting.
function cliError(message: string): Error {
	return Object.assign(new Error(message), { statusCode: 400 });
}

function tryCommand(command: string, args: string[]): string {
	try {
		return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

/**
 * The component (project) the credential is granted to, resolved the way `deploy_component` resolves
 * the project it deploys: an explicit `project` canonicalized (`@scope/app` deploys as `app`),
 * otherwise the name a `package` spec implies. Undefined when the request names neither — the caller
 * prompts, defaulting to the same directory name a `harper deploy` from here would send.
 *
 * The grant has to name the project the later deploy actually runs as: `resolveCredentials` rejects a
 * secret that isn't granted to it, so a name resolved any other way here seals a credential the
 * deploy refuses to use.
 */
export function resolveComponentName(req: any): string | undefined {
	if (typeof req.project === 'string' && req.project) return canonicalProjectName(req.project);
	// Not canonicalized further, matching the server: a package-derived name is used as-is, so a spec
	// that yields an unusable one (`…/repo.git` → `repo.git`) fails the grammar check below here rather
	// than at deploy time.
	if (typeof req.package === 'string' && req.package) return projectNameFromPackage(req.package);
	return undefined;
}

/**
 * The names a deploy would refuse, rejected here instead: a credential sealed and granted to a name
 * no deploy can run as is a durable secret nobody can ever use.
 */
export function assertUsableComponentName(component: string): void {
	if (!PROJECT_NAME_PATTERN.test(component)) {
		throw cliError(
			`"${component}" is not a usable component name — a deploy accepts letters, numbers, dashes and underscores.`
		);
	}
	if (isReservedComponentName(component)) {
		throw cliError(
			`"${component}" is reserved for Harper's "${component}" configuration section — deploying a component under that name is refused.`
		);
	}
}

/**
 * The canonical bare host for a git credential — `https://github.com/owner/repo` and
 * `git@github.com` both identify `github.com`. Resolved once and then used for everything the host
 * decides: which `gh` account token is read, the derived secret name, and the `host` on the printed
 * credentials entry. Without that, `host=ghe.example.com` would label (and store) the *default*
 * host's `gh` token for the enterprise host, and a later deploy would hand a github.com credential to
 * ghe.example.com.
 *
 * Anything still outside the deploy schema's `host` grammar after normalization is rejected here,
 * rather than sealed into a credential entry the deploy would refuse.
 */
export function resolveGitHost(host: unknown): string {
	const normalized = typeof host === 'string' ? normalizeGitHost(host) : '';
	if (!GIT_HOST_PATTERN.test(normalized)) {
		throw cliError(`Invalid git host ${JSON.stringify(host)} — expected a bare host, e.g. 'github.com'.`);
	}
	return normalized;
}

/**
 * Store the sealed envelope and make sure the component can use it, as two server-side atomic steps.
 * Returns the row's full grant list, as the server reports it.
 *
 * `grants` is deliberately omitted from `set_secret`: it *replaces* rather than merges
 * (`grants = dedupeGrants(req.grants ?? existing?.grants)`, secretOperations.ts), so sending only this
 * component would silently revoke a grant an operator had added with `grant_secret` — a monorepo's
 * second component being the realistic case, and invisible until its next deploy fails. Omitting the
 * field keeps the stored list untouched under the server's `withSecretLock`, and the idempotent
 * `grant_secret` then adds this component in a second locked step. Doing the merge on the client
 * instead would cost the same two round trips while reintroducing a race: a `revoke_secret` landing
 * between the read and the write would be silently undone.
 *
 * `processEnv: false` is explicit, and load-bearing rather than decorative. `set_secret` otherwise
 * inherits the stored tier, so if the derived row already existed as a processEnv (global) secret the
 * pasted token would be written into the tier every component and child process reads — and only then
 * would `grant_secret` reject the row for being global, leaving the CLI reporting a failure it had
 * already committed. (Sending `grants` used to mask this: the server rejects processEnv+grants before
 * writing. Omitting them for the merge above removed that accident, so the intent is now stated.) This
 * converts such a row to the scoped tier, which is what this flow promises — and the name is
 * component-derived, so a global secret at it was never serving anything the scoped one doesn't.
 *
 * A brand-new row is briefly ungranted between the calls, which is harmless — it can't be resolved by
 * any deploy until the grant lands. Nothing is printed until both steps succeed, so a failure part-way
 * doesn't claim a credential is ready to use.
 */
export async function storeSealedSecret(
	transport: any,
	secretName: string,
	envelope: string,
	component: string
): Promise<string[]> {
	await cliOperations({ ...transport, operation: 'set_secret', name: secretName, envelope, processEnv: false }, true);
	const granted: any = await cliOperations(
		{ ...transport, operation: 'grant_secret', name: secretName, component },
		true
	);
	return Array.isArray(granted?.grants) ? granted.grants : [component];
}

export async function deploySetup(req: any): Promise<void> {
	// Every operation this flow issues rides the caller's connection context — the target, the
	// explicitly passed credentials, the TLS strictness — so the seal is stored on the instance the
	// user is talking to, as the identity they authenticated as. Only those fields carry over; the
	// deploy args that brought us here (`setup`, `token`, `package`) never reach either body.
	const transport = transportContext(req);

	// 1. Fetch the cluster's public secrets key. Not wrapped in a try/catch: `cliOperations` reports
	// the failure and exits rather than throwing, so a catch here would be dead code promising a
	// friendlier message that never runs.
	const keyResponse: any = await cliOperations({ ...transport, operation: 'get_secrets_public_key' }, true);
	const publicKey: string | undefined = keyResponse?.public_key;
	const fingerprint: string | undefined = keyResponse?.fingerprint;
	if (!publicKey || !fingerprint) {
		throw cliError(
			"This cluster didn't return a secrets public key — secrets custody isn't initialized on it " +
				'(available on Harper Pro / Fabric). Without it, a credential cannot be sealed client-side.'
		);
	}

	// 2. Which private source?
	const provider: string =
		req.provider ??
		(
			await inquirer.prompt({
				type: 'list',
				name: 'provider',
				message: 'What private source needs a credential?',
				choices: [
					{ name: 'GitHub repository (private git clone)', value: 'github' },
					{ name: 'npm registry (private packages / dependencies)', value: 'npm' },
				],
			})
		).provider;

	if (provider !== 'github' && provider !== 'npm') {
		throw cliError(`Unsupported provider "${provider}" — supported providers are "github" and "npm".`);
	}

	// 3. Which component is the credential for? (the grant is scoped to it)
	const component =
		resolveComponentName(req) ??
		canonicalProjectName(
			(
				await inquirer.prompt({
					type: 'input',
					name: 'project',
					message: 'Component (project) name this credential is for:',
					default: directoryProjectName(),
				})
			).project ?? ''
		);
	assertUsableComponentName(component);

	let credentialKey: string; // host (github) or registry (npm) — the credentials-entry discriminator
	let credentialEntry: Record<string, string>;
	let token: string | undefined = req.token;

	if (provider === 'github') {
		const host = resolveGitHost(req.host ?? 'github.com');
		credentialKey = host;
		if (!token) {
			// Bound to the host being provisioned: `gh auth token` with no `--hostname` returns whichever
			// host gh considers default, which for a GHE host is the wrong account's token.
			const ghToken = tryCommand('gh', ['auth', 'token', '--hostname', host]);
			// A fine-grained PAT is offered FIRST, and is therefore the default selection. What gets
			// sealed here is durable and replayed on every cold deploy and rollback, so it should be
			// the narrowest credential that does the job — one repo, Contents: Read-only. A `gh` CLI
			// session token is one keypress cheaper but typically carries repo/read:org/gist/workflow
			// across the whole account, so offering it first would make least privilege the path of
			// most resistance.
			const choices: Array<{ name: string; value: string }> = [
				{ name: 'Paste a fine-grained PAT (Contents: Read-only on this repo) — recommended', value: 'paste' },
			];
			// Offered only when gh actually holds a token for *this* host, so choosing it can't fall back
			// to another host's credential.
			if (ghToken) {
				choices.push({ name: `Use your gh CLI session token for ${host} (broad account scopes)`, value: 'gh' });
			}
			const how =
				choices.length === 1
					? 'paste'
					: (
							await inquirer.prompt({
								type: 'list',
								name: 'how',
								message: 'How should I get the GitHub token?',
								choices,
							})
						).how;
			if (how === 'gh') {
				console.log(
					chalk.yellow(
						'Note: your gh CLI token usually carries broad account scopes (repo, read:org, gist,\n' +
							'  workflow) and is long-lived. It will be stored encrypted and reused for future\n' +
							'  deploys and rollbacks of this component. A fine-grained PAT is the safer choice.'
					)
				);
				token = ghToken;
			} else {
				console.log(
					chalk.gray(
						`Create one at https://${host}/settings/personal-access-tokens/new\n` +
							'  Repository access → only your repo; Permissions → Contents: Read-only.'
					)
				);
				token = (await inquirer.prompt({ type: 'password', name: 'token', message: 'Paste the token:', mask: '*' }))
					.token;
			}
		}
		credentialEntry = { host };
	} else {
		const registry = typeof req.registry === 'string' && req.registry ? req.registry : 'registry.npmjs.org';
		credentialKey = registry;
		if (!token) {
			console.log(chalk.gray('Tip: `npm token create --read-only` mints a granular npm token from the CLI.'));
			token = (await inquirer.prompt({ type: 'password', name: 'token', message: 'Paste the npm token:', mask: '*' }))
				.token;
		}
		credentialEntry = req.scope ? { registry, scope: req.scope } : { registry };
	}

	token = typeof token === 'string' ? token.trim() : undefined;
	if (!token) throw cliError('No token was provided; nothing to store.');

	// 4. Seal the token locally. Only ciphertext leaves this machine.
	const envelope = ENV_ENCRYPTED_PREFIX + encryptEnvelope(token, publicKey, fingerprint);

	// 5. Store the sealed token, granted to the component. The server never sees the plaintext. The
	// derived name is the one the server's literal-token path would use for the same component and
	// host/registry, so re-running this rotates the same row rather than piling up a second one.
	const secretName =
		provider === 'github'
			? deriveGitSecretName(component, credentialKey)
			: deriveRegistrySecretName(component, credentialKey);
	const grants = await storeSealedSecret(transport, secretName, envelope, component);

	// 6. Print the credentials reference the deploy should use.
	credentialEntry.secret = secretName;
	console.log(chalk.green(`\n✓ Sealed "${credentialKey}" credential and stored it as secret "${secretName}".`));
	console.log(chalk.gray("  It was encrypted here with the cluster's public key — only ciphertext was sent."));
	const grantSummary =
		grants.length > 1 ? `components ${grants.map((g) => `"${g}"`).join(', ')}` : `component "${component}"`;
	console.log(chalk.gray(`  Granted to ${grantSummary}; the cluster decrypts it only at deploy/rollback time.`));
	console.log('\nUse it in your deploy:');
	console.log(chalk.cyan(`  credentials='${JSON.stringify([credentialEntry])}'`));
	if (provider === 'github') {
		console.log(
			chalk.gray(
				`  e.g. harper deploy_component project=${component} package=github:<owner>/<repo>#<sha> \\\n` +
					`         credentials='${JSON.stringify([credentialEntry])}' restart=true replicated=true`
			)
		);
	}
}
