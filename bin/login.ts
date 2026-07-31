import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import inquirer from 'inquirer';
import { saveCredentials, normalizeTarget } from './cliCredentials.ts';
import { cliOperations } from './cliOperations.ts';

/**
 * Executes the login command.
 *
 * With `forCi`, stdout carries *only* the machine-readable CI/CD credential block (dotenv format)
 * and every human-facing byte — banner, prompts, status — goes to stderr, so the command can be
 * piped straight into a secret store or the clipboard without the token ever hitting the screen or
 * the shell history. See `printCiCdEnv`.
 */
export async function login(
	targetArg: string,
	usernameArg: string,
	{ forCi = false }: { forCi?: boolean } = {}
): Promise<void> {
	dotenv.config();

	// In --for-ci mode stdout is reserved for the credential block, so anything a human reads is
	// written to stderr instead. inquirer defaults to stdout too, hence its own output stream —
	// without it the user would be typing their password blind into the pipe.
	const say = forCi ? (message = '') => process.stderr.write(`${message}\n`) : (message = '') => console.log(message);
	const ask = forCi ? inquirer.createPromptModule({ output: process.stderr }) : inquirer.prompt;

	say(chalk.cyan('\nHarper login'));
	say(
		chalk.gray(
			'Harper apps can be deployed to Fabric for free, where one runtime can house your app, database, cache, and messaging.'
		)
	);
	say(chalk.gray('https://fabric.harper.fast/\n'));
	say(
		chalk.gray('If you create a cluster, you can enter your credentials here. They will be exchanged for a JWT from')
	);
	say(chalk.gray('your cluster, which will be saved inside ~/.harperdb/credentials.json\n'));

	if (forCi) {
		say(
			chalk.yellow(
				'Harper stores one refresh token per user, so this login replaces whatever refresh token\n' +
					'that user already holds — including one a CI runner may be using right now. Log in as a\n' +
					'user created for this single consumer, not your personal account.\n'
			)
		);
	}

	const defaultTarget = process.env.HARPER_CLI_TARGET || process.env.CLI_TARGET;
	let target = targetArg || defaultTarget;

	if (!targetArg) {
		const { target: input } = await ask({
			type: 'input',
			name: 'target',
			message: 'Cluster Target URL:',
			default: defaultTarget,
		});
		if (input?.trim()) {
			target = input.trim();
		}
	}

	if (!target) {
		console.error(chalk.red('Target URL is required.'));
		process.exit(1);
	}

	target = normalizeTarget(target);

	// Whichever env namespace supplies anything owns both halves: taking a username from
	// HARPER_CLI_USERNAME and a password from CLI_TARGET_PASSWORD would log in as one identity
	// using another's secret. A half the chosen namespace doesn't set is prompted for, never
	// borrowed from the other one.
	const envPrefix = ['HARPER_CLI', 'CLI_TARGET'].find(
		(prefix) => process.env[`${prefix}_USERNAME`] || process.env[`${prefix}_PASSWORD`]
	);
	const envUsername = envPrefix && process.env[`${envPrefix}_USERNAME`];
	const envPassword = envPrefix && process.env[`${envPrefix}_PASSWORD`];

	let targetUsername = usernameArg;
	if (!targetUsername) {
		if (envUsername) {
			targetUsername = envUsername;
			say(chalk.gray(`Using username from ${envPrefix}_USERNAME environment variable: ${targetUsername}`));
		} else {
			({ username: targetUsername } = await ask({
				type: 'input',
				name: 'username',
				message: forCi ? 'CI Username (a user dedicated to this consumer):' : 'Cluster Username:',
			}));
		}
	}

	// The CLI cannot verify that a user is dedicated to CI, but it can refuse to rotate that user's
	// only refresh token silently: name the user and make someone say yes. Skipped when stdin is not
	// a TTY — a runner has already committed to this and there is nobody to ask.
	if (forCi && process.stdin.isTTY) {
		const { confirmed } = await ask({
			type: 'confirm',
			name: 'confirmed',
			message: `Mint a CI refresh token for '${targetUsername}'? This revokes any refresh token it already holds.`,
			default: false,
		});
		if (!confirmed) {
			console.error(chalk.red('Aborted. Create a user dedicated to this CI consumer and log in as that user.'));
			process.exit(1);
		}
	}

	let targetPassword = envPassword;

	if (targetPassword) {
		say(chalk.gray(`Using password from ${envPrefix}_PASSWORD environment variable.`));
	} else {
		// `type: 'password'` with no `mask` hides input entirely — nothing is echoed until Enter.
		({ password: targetPassword } = await ask({
			type: 'password',
			name: 'password',
			message: 'Cluster Password:',
		}));
	}

	if (!targetUsername || !targetPassword) {
		console.error('Username and password are required.');
		process.exit(1);
	}

	const req = {
		operation: 'create_authentication_tokens',
		username: targetUsername,
		password: targetPassword,
		// Also passed as dedicated transport credentials: these ARE the caller's credentials, so
		// the request must authenticate as them rather than reach for a saved token — which, on a
		// re-login after expiry, would try (and fail) to refresh the very token being replaced.
		auth_username: targetUsername,
		auth_password: targetPassword,
		target,
	};

	const response = await cliOperations(req, true);

	if (response && response.operation_token) {
		const resolvedTarget = response.target || req.target || response.resolvedTarget || target;
		try {
			saveCredentials(resolvedTarget, {
				operation_token: response.operation_token,
				refresh_token: response.refresh_token,
			});
		} catch (err) {
			console.error(chalk.red(err instanceof Error ? err.message : String(err)));
			process.exit(1);
		}

		// If CLI_TARGET is not in process.env before we started (meaning it's not in .env or other env vars),
		// and we just logged in with a target, let's consider adding it to .env. This is non-critical
		// (credentials are already saved), so a filesystem error here must not crash the CLI.
		try {
			const envPath = path.join(process.cwd(), '.env');
			if (fs.existsSync(envPath)) {
				const envConfig = dotenv.parse(fs.readFileSync(envPath));

				if (
					!envConfig.CLI_TARGET &&
					!envConfig.HARPER_CLI_TARGET &&
					!process.env.CLI_TARGET &&
					!process.env.HARPER_CLI_TARGET
				) {
					const envLine = `\nHARPER_CLI_TARGET=${resolvedTarget}\n`;
					fs.appendFileSync(envPath, envLine);
					say(`Added HARPER_CLI_TARGET to .env`);
				}
			}
		} catch (err) {
			console.error(chalk.yellow(`Could not update .env: ${err instanceof Error ? err.message : String(err)}`));
		}

		say(`Successfully logged in to ${resolvedTarget} and saved credentials.`);

		if (forCi) printCiCdEnv(resolvedTarget, response.refresh_token, targetUsername);

		process.exit(0);
	} else {
		throw new Error('Failed to retrieve authentication tokens.');
	}
}

/**
 * Writes the environment variables that let a CI/CD pipeline (GitHub Actions, etc.) run
 * `harper deploy` without a stored password. Emits the long-lived refresh token only —
 * cliOperations' Bearer-token path mints a fresh operation token from it on each run
 * (HARPER_CLI_REFRESH_TOKEN), so it's the single durable secret CI needs.
 *
 * stdout gets nothing but the `KEY=value` lines, in dotenv format and free of ANSI codes, so the
 * whole command pipes cleanly into a secret store or the clipboard and the token never appears
 * on screen or in shell history:
 *
 *   harper login --for-ci | gh secret set --env-file -   # sets both secrets on the repo
 *   harper login --for-ci | pbcopy                       # or paste them in by hand
 *
 * That's also why the explanatory comments go to stderr rather than riding along as `#` lines:
 * every consumer of this block reads it as data.
 *
 * `target` needs no sanitizing here: `normalizeTarget` guarantees a credential-free target, which is
 * the same value already stored, echoed and written to `.env`.
 */
function printCiCdEnv(target: string, refreshToken: string, username: string): void {
	if (!refreshToken) {
		// Fail loudly instead of emitting a half-block: a silent empty stdout would be piped
		// straight into a secret store and "succeed" at storing nothing.
		console.error(
			chalk.red(
				'This cluster returned no refresh token, so there is no durable credential to give CI.\n' +
					'Upgrade the cluster, or authenticate CI with HARPER_CLI_USERNAME/HARPER_CLI_PASSWORD instead.'
			)
		);
		process.exit(1);
	}

	process.stderr.write(
		chalk.gray(
			'\n# Store these as secrets in your CI/CD provider (e.g. GitHub Actions repository secrets)\n' +
				'# and expose them as environment variables to your `harper deploy` step. The refresh\n' +
				'# token is long-lived; the CLI mints a fresh operation token from it on each run.\n'
		)
	);
	process.stderr.write(chalk.yellow(rotationWarning(username)));
	process.stdout.write(`HARPER_CLI_TARGET=${target}\n`);
	process.stdout.write(`HARPER_CLI_REFRESH_TOKEN=${refreshToken}\n`);
}

/**
 * Harper stores exactly one refresh-token hash per user (`createTokens` overwrites
 * `hdb_user.refresh_token`, and refresh validation accepts only that hash), so minting a refresh
 * token revokes that user's previous one. There is no way to hold two live refresh credentials for
 * one user, which makes rotation — not concurrency — the property a CI credential has to be built
 * around, and it is invisible until a second holder's next refresh 401s. Until the server grows
 * named, independently revocable credentials (HarperFast/harper#2018), the CLI's job is to make
 * that unmissable and to push each consumer onto its own user.
 */
function rotationWarning(username: string): string {
	return (
		`\nOne refresh token per user: this replaced any refresh token '${username}' already held.\n` +
		`Anything still using an older one — another runner, another machine, an earlier\n` +
		`'harper login' — will fail on its next refresh. Give each CI consumer its own user.\n`
	);
}
