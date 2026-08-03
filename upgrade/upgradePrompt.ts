'use strict';

import prompt from 'prompt';
import chalk from 'chalk';
import * as os from 'os';
import assignCMDENVVariables from '../utility/assignCmdEnvVariables.ts';

const UPGRADE_PROCEED = ['yes', 'y'];

/**
 * Prompt the user before proceeding with a minor version downgrade
 * @param upgradeObj - {UpgradeObject} Object includes the versions the data and current install are on
 * @returns {Promise<boolean>}
 */
export async function forceDowngradePrompt(upgradeObj: any) {
	const override = assignCMDENVVariables(['CONFIRM_DOWNGRADE']);
	// Without a terminal, prompt.get() blocks on stdin forever (systemd, containers, CI) — and an
	// override value the prompt library rejects (its pattern is lowercase-only) is deleted and
	// falls through to that same blocking read. So with no TTY, resolve the answer here and never
	// reach the prompt (#2046).
	if (!process.stdin.isTTY) {
		if (override.CONFIRM_DOWNGRADE === undefined) {
			throw new Error(
				`This instance's data was last run on Harper ${upgradeObj.data_version}, which is newer than this installed version ${upgradeObj.upgrade_version}.` +
					' Running the older version requires confirmation, and there is no interactive terminal to ask on.' +
					' Set CONFIRM_DOWNGRADE=yes (environment variable or --CONFIRM_DOWNGRADE yes) to proceed with the downgrade,' +
					` or run Harper ${upgradeObj.data_version} or newer.`
			);
		}
		const answer = override.CONFIRM_DOWNGRADE.toLowerCase();
		if (UPGRADE_PROCEED.includes(answer)) return true;
		if (answer === 'no' || answer === 'n') return false;
		throw new Error(`Unrecognized CONFIRM_DOWNGRADE value '${override.CONFIRM_DOWNGRADE}'; use yes or no.`);
	}
	let downgradeMessage =
		`${os.EOL}` +
		chalk.bold.green(
			'Your installed Harper version is older than the version used to create your data.' +
				' Downgrading is not recommended as it is not tested and guaranteed to work. However, if you need to' +
				' downgrade, and a backup of your data has not been created, we recommend you cancel this process and' +
				' backup before proceeding.' +
				`${os.EOL}`
		);
	prompt.override = override;
	prompt.start();
	prompt.message = downgradeMessage;
	let downgradeConfirmation = {
		properties: {
			CONFIRM_DOWNGRADE: {
				description: chalk.magenta(
					`${os.EOL}[CONFIRM_DOWNGRADE] Do you want to proceed with using your downgraded HDB instance now? (yes/no)`
				),
				pattern: /y(es)?$|n(o)?$/,
				message: "Must respond 'yes' or 'no'",
				default: 'no',
				required: true,
			},
		},
	};

	let response = await prompt.get([downgradeConfirmation]);

	return UPGRADE_PROCEED.includes(response.CONFIRM_DOWNGRADE);
}

export async function upgradeCertsPrompt() {
	const upgradeCertMessage =
		`${os.EOL}` +
		chalk.bold.green(
			'We now require a Certifacte Authority certificate. Harper can generate all new certificates for you (your existing certificates will be backed up) ' +
				'or you can keep any existing certificates and add your own CA certificate. To add your own CA certificate set the <certificateAuthority> ' +
				'parameter in harperdb-config.yaml'
		);

	prompt.override = assignCMDENVVariables(['GENERATE_CERTS']);
	prompt.start();
	prompt.message = upgradeCertMessage;
	let upgradeConfirmation = {
		properties: {
			GENERATE_CERTS: {
				description: chalk.magenta(
					`${os.EOL}[GENERATE_CERTS] Do you want Harper to generate all new certificates? (yes/no)`
				),
				pattern: /y(es)?$|n(o)?$/,
				message: "Must respond 'yes' or 'no'",
				default: 'yes',
				required: true,
			},
		},
	};

	const response = await prompt.get([upgradeConfirmation]);

	return UPGRADE_PROCEED.includes(response.GENERATE_CERTS);
}
