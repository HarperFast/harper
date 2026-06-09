'use strict';

import prompt from 'prompt';
import chalk from 'chalk';
import * as os from 'os';
import assignCMDENVVariables from '../utility/assignCmdEnvVariables.ts';

const UPGRADE_PROCEED = ['yes', 'y'];

/**
 * Prompt the user before proceeding with a minor version downgrade
 * @param _upgradeObj - {UpgradeObject} Object includes the versions the data and current install are on
 * @returns {Promise<boolean>}
 */
export async function forceDowngradePrompt(_upgradeObj: any) {
	let downgradeMessage =
		`${os.EOL}` +
		chalk.bold.green(
			'Your installed Harper version is older than the version used to create your data.' +
				' Downgrading is not recommended as it is not tested and guaranteed to work. However, if you need to' +
				' downgrade, and a backup of your data has not been created, we recommend you cancel this process and' +
				' backup before proceeding.' +
				`${os.EOL}`
		);
	prompt.override = assignCMDENVVariables(['CONFIRM_DOWNGRADE']);
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
