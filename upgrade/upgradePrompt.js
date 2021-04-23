"use strict";

const prompt = require('prompt');
const minimist = require('minimist');
const colors = require("colors/safe");
const log = require('../utility/logging/harper_logger');
const os = require('os');
const directivesManager = require('./directivesManager');

const UPGRADE_PROCEED = ['yes', 'y'];

/**
 * Prompt the user that they need to run the upgrade scripts, typically after upgrading via a package manager.
 * @param upgrade_object - {UpgradeObject} Object includes the versions the data and current install are on
 * @returns {Promise<boolean>}
 */
async function forceUpdatePrompt(upgrade_obj) {
    // pull and format directive changes for prompt
    let changes = directivesManager.getDirectiveChangeDescriptions(upgrade_obj);
    let counter = 1;
    let message = `${os.EOL}` + colors.bold.green('Your current HarperDB version requires that we complete an update process.')
        + `${os.EOL}` + 'If a backup of your data has not been created, we recommend you cancel this process and backup before proceeding.'
        + `${os.EOL}${os.EOL}` + colors.underline('The following updates will be implemented as a part of this upgrade:') + `${os.EOL}`;
    /*
        Should create a message to the user that describes the changes specified in the directives as a numbered list.
     */
    changes.forEach((change) => {
       if(change.change_description) {
           message = `${message} ${counter}. ${change.change_description} ${os.EOL}`;
           counter++;
       }
    });
    prompt.override = minimist(process.argv);
    prompt.start();
    prompt.message = message;
    let upgrade_confirmation = {
        properties: {
            CONFIRM_UPGRADE: {
                description: colors.magenta(`${os.EOL}[CONFIRM_UPGRADE] Do you want to upgrade your HDB instance now? (yes/no)`),
                pattern: /y(es)?$|n(o)?$/,
                message: "Must respond 'yes' or 'no'",
                default: 'no',
                required: true
            }
        }
    };

    let response;
    try {
        response = await prompt.get([upgrade_confirmation]);
    } catch(err) {
        log.error('There was an error when prompting user about an upgrade.');
        log.error(err);
        return false;
    }

    return UPGRADE_PROCEED.includes(response.CONFIRM_UPGRADE);
}

module.exports = {
    forceUpdatePrompt
};
