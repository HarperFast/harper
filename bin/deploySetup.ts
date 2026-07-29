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
//   4. set_secret {envelope}    → store ciphertext, granted to the component
//   5. print the `credentials` reference the deploy should use

import chalk from 'chalk';
import inquirer from 'inquirer';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliOperations } from './cliOperations.ts';
import { encryptEnvelope } from '../utility/secretEnvelope.ts';
import { ENV_ENCRYPTED_PREFIX } from '../utility/envFile.ts';

// Mirror the server's derived secret names (secretOperations.ts `deriveRegistrySecretName` and
// `deriveGitSecretName`) EXACTLY, so a `deploy setup` seal and a later literal-token deploy overwrite
// the SAME hdb_secret row. git hosts get a `.git.` segment (and normalizeGitHost handling); registries
// don't — without the segment, a git and a registry credential for the same host would collide.
export function deriveSecretName(component: string, key: string, provider: string): string {
	const componentPart = String(component).replace(/[^\w.-]+/g, '_');
	if (provider === 'github') {
		// mirrors gitCredentialServer.normalizeGitHost() + deriveGitSecretName's `.git.` segment
		const hostPart = key
			.trim()
			.replace(/^[a-z0-9+.-]+:\/\//i, '')
			.replace(/^\/\//, '')
			.replace(/\/.*$/, '')
			.replace(/^[^@]*@/, '')
			.toLowerCase()
			.replace(/[^\w.-]+/g, '_');
		return `deploy.${componentPart}.git.${hostPart}`;
	}
	const registryPart = key
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/^\/\//, '')
		.replace(/\/+$/, '')
		.toLowerCase()
		.replace(/[^\w.-]+/g, '_');
	return `deploy.${componentPart}.${registryPart}`;
}

function tryCommand(command: string, args: string[]): string {
	try {
		return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

function defaultComponentName(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
		if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name.replace(/^@[^/]+\//, '');
	} catch {
		// no package.json — fall back to the directory name
	}
	return path.basename(process.cwd());
}

export async function deploySetup(req: any): Promise<void> {
	// 1. Fetch the cluster's public secrets key. Target + auth are resolved by cliOperations exactly
	// as they are for a deploy (harper login, or CLI_TARGET + HARPER_CLI_USERNAME/PASSWORD).
	let keyResponse: any;
	try {
		keyResponse = await cliOperations({ operation: 'get_secrets_public_key', target: req.target }, true);
	} catch (error) {
		throw new Error(
			`Could not fetch the cluster's secrets public key: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const publicKey: string | undefined = keyResponse?.public_key;
	const fingerprint: string | undefined = keyResponse?.fingerprint;
	if (!publicKey || !fingerprint) {
		throw new Error(
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
		throw new Error(`Unsupported provider "${provider}" — supported providers are "github" and "npm".`);
	}

	// 3. Which component is the credential for? (the grant is scoped to it)
	const component: string =
		req.project ??
		req.component ??
		(
			await inquirer.prompt({
				type: 'input',
				name: 'component',
				message: 'Component (project) name this credential is for:',
				default: defaultComponentName(),
			})
		).component;

	let credentialKey: string; // host (github) or registry (npm) — the credentials-entry discriminator
	let credentialEntry: Record<string, string>;
	let token: string | undefined = req.token;

	if (provider === 'github') {
		const host = req.host ?? 'github.com';
		credentialKey = host;
		if (!token) {
			const ghToken = tryCommand('gh', ['auth', 'token']);
			const choices: Array<{ name: string; value: string }> = [];
			if (ghToken) choices.push({ name: 'Use your gh CLI session token (gh auth token)', value: 'gh' });
			choices.push({ name: 'Paste a fine-grained PAT (Contents: Read-only on this repo)', value: 'paste' });
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
				token = ghToken;
			} else {
				console.log(
					chalk.gray(
						'Create one at https://github.com/settings/personal-access-tokens/new\n' +
							'  Repository access → only your repo; Permissions → Contents: Read-only.'
					)
				);
				token = (await inquirer.prompt({ type: 'password', name: 'token', message: 'Paste the token:', mask: '*' }))
					.token;
			}
		}
		credentialEntry = { host };
	} else {
		const registry = req.registry ?? 'registry.npmjs.org';
		credentialKey = registry;
		if (!token) {
			console.log(chalk.gray('Tip: `npm token create --read-only` mints a granular npm token from the CLI.'));
			token = (await inquirer.prompt({ type: 'password', name: 'token', message: 'Paste the npm token:', mask: '*' }))
				.token;
		}
		credentialEntry = req.scope ? { registry, scope: req.scope } : { registry };
	}

	token = typeof token === 'string' ? token.trim() : undefined;
	if (!token) throw new Error('No token was provided; nothing to store.');

	// 4. Seal the token locally. Only ciphertext leaves this machine.
	const envelope = ENV_ENCRYPTED_PREFIX + encryptEnvelope(token, publicKey, fingerprint);

	// 5. Store the sealed token, granted to the component. The server never sees the plaintext.
	const secretName = deriveSecretName(component, credentialKey, provider);
	await cliOperations(
		{ operation: 'set_secret', name: secretName, envelope, grants: [component], target: req.target },
		true
	);

	// 6. Print the credentials reference the deploy should use.
	credentialEntry.secret = secretName;
	console.log(chalk.green(`\n✓ Sealed "${credentialKey}" credential and stored it as secret "${secretName}".`));
	console.log(chalk.gray("  It was encrypted here with the cluster's public key — only ciphertext was sent."));
	console.log(
		chalk.gray(`  Granted to component "${component}"; the cluster decrypts it only at deploy/rollback time.`)
	);
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
