import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { saveCredentials, normalizeTarget } from './cliCredentials.ts';
import { cliOperations } from './cliOperations.ts';

/**
 * Executes the login command.
 */
export async function login(targetArg: string, usernameArg: string): Promise<void> {
	dotenv.config();

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
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
		let skipTargetPrompt = !!targetArg;

		if (!skipTargetPrompt) {
			if (defaultTarget) {
				const input = await rl.question(`Cluster Target [${defaultTarget}]: `);
				if (input.trim()) {
					target = input.trim();
				}
			} else {
				target = await rl.question(`Cluster Target URL: `);
			}
		}

		if (!target) {
			console.error(chalk.red('Target URL is required.'));
			process.exit(1);
		}

		target = normalizeTarget(target);

		let targetUsername = usernameArg;
		if (!targetUsername) {
			if (process.env.CLI_TARGET_USERNAME) {
				targetUsername = process.env.CLI_TARGET_USERNAME;
				console.log(chalk.gray(`Using username from CLI_TARGET_USERNAME environment variable: ${targetUsername}`));
			} else if (process.env.HARPER_CLI_USERNAME) {
				targetUsername = process.env.HARPER_CLI_USERNAME;
				console.log(chalk.gray(`Using username from HARPER_CLI_USERNAME environment variable: ${targetUsername}`));
			} else {
				targetUsername = await rl.question(`Cluster Username: `);
			}
		}

		let targetPassword = process.env.CLI_TARGET_PASSWORD || process.env.HARPER_CLI_PASSWORD;

		if (targetPassword) {
			const envVarName = process.env.CLI_TARGET_PASSWORD ? 'CLI_TARGET_PASSWORD' : 'HARPER_CLI_PASSWORD';
			console.log(chalk.gray(`Using password from ${envVarName} environment variable.`));
		} else {
			targetPassword = await new Promise((resolve) => {
				process.stdout.write(`Cluster Password: `);
				process.stdin.setRawMode(true);
				process.stdin.resume();
				let password = '';
				const onData = (data: Buffer) => {
					for (let i = 0; i < data.length; i++) {
						const char = data[i];
						if (char === 13 || char === 10) {
							// \r or \n
							process.stdout.write('\n');
							cleanup();
							resolve(password);
							return;
						} else if (char === 3) {
							// Ctrl+C
							process.stdout.write('\n');
							cleanup();
							process.exit(1);
						} else if (char === 8 || char === 127) {
							// Backspace
							if (password.length > 0) {
								password = password.slice(0, -1);
								process.stdout.write('\b \b');
							}
						} else {
							password += data.toString('utf-8', i, i + 1);
							process.stdout.write('*');
						}
					}
				};

				const cleanup = () => {
					process.stdin.removeListener('data', onData);
					process.stdin.setRawMode(false);
					process.stdin.pause();
				};

				process.stdin.on('data', onData);
			});
		}

		if (!targetUsername || !targetPassword) {
			console.error('Username and password are required.');
			process.exit(1);
		}

		const req = {
			operation: 'create_authentication_tokens',
			username: targetUsername,
			password: targetPassword,
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
				console.error(chalk.red(err.message));
				process.exit(1);
			}

			// If CLI_TARGET is not in process.env before we started (meaning it's not in .env or other env vars),
			// and we just logged in with a target, let's consider adding it to .env
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

			console.log(`Successfully logged in to ${resolvedTarget} and saved credentials.`);
			process.exit(0);
		} else {
			throw new Error('Failed to retrieve authentication tokens.');
		}
	} finally {
		rl.close();
	}
}
