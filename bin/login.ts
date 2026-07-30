import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import inquirer from 'inquirer';
import { saveCredentials, normalizeTarget } from './cliCredentials.ts';
import { cliOperations } from './cliOperations.ts';

/**
 * Executes the login command.
 */
export async function login(targetArg: string, usernameArg: string): Promise<void> {
	dotenv.config();

	console.log(chalk.cyan('\nHarper login'));
	console.log(
		chalk.gray(
			'Harper apps can be deployed to Fabric for free, where one runtime can house your app, database, cache, and messaging.'
		)
	);
	console.log(chalk.gray('https://fabric.harper.fast/\n'));
	console.log(
		chalk.gray('If you create a cluster, you can enter your credentials here. They will be exchanged for a JWT from')
	);
	console.log(chalk.gray('your cluster, which will be saved inside ~/.harperdb/credentials.json\n'));

	const defaultTarget = process.env.HARPER_CLI_TARGET || process.env.CLI_TARGET;
	let target = targetArg || defaultTarget;

	if (!targetArg) {
		const { target: input } = await inquirer.prompt({
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
			console.log(chalk.gray(`Using username from ${envPrefix}_USERNAME environment variable: ${targetUsername}`));
		} else {
			({ username: targetUsername } = await inquirer.prompt({
				type: 'input',
				name: 'username',
				message: 'Cluster Username:',
			}));
		}
	}

	let targetPassword = envPassword;

	if (targetPassword) {
		console.log(chalk.gray(`Using password from ${envPrefix}_PASSWORD environment variable.`));
	} else {
		// `type: 'password'` with no `mask` hides input entirely — nothing is echoed until Enter.
		({ password: targetPassword } = await inquirer.prompt({
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
					console.log(`Added HARPER_CLI_TARGET to .env`);
				}
			}
		} catch (err) {
			console.error(chalk.yellow(`Could not update .env: ${err instanceof Error ? err.message : String(err)}`));
		}

		console.log(`Successfully logged in to ${resolvedTarget} and saved credentials.`);
		process.exit(0);
	} else {
		throw new Error('Failed to retrieve authentication tokens.');
	}
}
