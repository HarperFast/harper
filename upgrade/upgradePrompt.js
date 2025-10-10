'use strict';

const prompt = require('prompt');
const chalk = require('chalk');
const log = require('../utility/logging/harper_logger.js');
const os = require('os');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables.js');

const UPGRADE_PROCEED = ['yes', 'y'];

/**
 * Prompt the user that they need to run the upgrade scripts, typically after upgrading via a package manager.
 * @param upgradeObject - {UpgradeObject} Object includes the versions the data and current install are on
 * @returns {Promise<boolean>}
 */
async function forceUpdatePrompt(upgradeObj) {
	let upgradeMessage =
		`${os.EOL}` +
		chalk.bold.green('Your current HarperDB version requires that we complete an update process.') +
		`${os.EOL}` +
		'If a backup of your data has not been created, we recommend you cancel this process and backup before proceeding.' +
		`${os.EOL}${os.EOL}` +
		'You can read more about the changes in this upgrade at https://harperdb.io/developers/release-notes/' +
		`${os.EOL}`;
	prompt.override = assignCMDENVVariables(['CONFIRM_UPGRADE']);
	prompt.start();
	prompt.message = upgradeMessage;
	let upgradeConfirmation = {
		properties: {
			CONFIRM_UPGRADE: {
				description: chalk.magenta(`${os.EOL}[CONFIRM_UPGRADE] Do you want to upgrade your HDB instance now? (yes/no)`),
				pattern: /y(es)?$|n(o)?$/,
				message: "Must respond 'yes' or 'no'",
				default: 'no',
				required: true,
			},
		},
	};

	let response;
	try {
		response = await prompt.get([upgradeConfirmation]);
	} catch (err) {
		log.error('There was an error when prompting user about an upgrade.');
		log.error(err);
		return false;
	}

	return UPGRADE_PROCEED.includes(response.CONFIRM_UPGRADE);
}

/**
 * Prompt the user before proceeding with a minor version downgrade
 * @param upgradeObject - {UpgradeObject} Object includes the versions the data and current install are on
 * @returns {Promise<boolean>}
 */
async function forceDowngradePrompt(upgradeObj) {
	let downgradeMessage =
		`${os.EOL}` +
		chalk.bold.green(
			'Your installed HarperDB version is older than the version used to create your data.' +
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

async function upgradeCertsPrompt() {
	const upgradeCertMessage =
		`${os.EOL}` +
		chalk.bold.green(
			'We now require a Certifacte Authority certificate. HarperDB can generate all new certificates for you (your existing certificates will be backed up) ' +
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
					`${os.EOL}[GENERATE_CERTS] Do you want HarperDB to generate all new certificates? (yes/no)`
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

module.exports = {
	forceUpdatePrompt,
	forceDowngradePrompt,
	upgradeCertsPrompt,
};
