"use strict";

const log = require('../logging/harper_logger');
const { Select } = require('enquirer');
const os = require('os');
const upgrade = require('../../bin/upgrade');

const UPGRADE_PROCEED = 'Yes, proceed';
const UPGRADE_CANCEL = 'No, cancel the upgrade';

async function forceUpdatePrompt(old_version_string, new_version_string) {
    // pull directive changes
    let changes = upgrade.listDirectiveChanges(old_version_string, new_version_string);
    let counter = 1;
    let message = 'HarperDB has been recently updated, we need to complete the update process.  If a backup of your data has not been created, cancel this process and backup.  The following data will be affected:';
    message = message + os.EOL;
    /*
        Should create a message to the user that describes the changes specified in the directives as a numbered list.
     */
    changes.forEach((change) => {
       if(change.change_description) {
           message = `${message} ${counter}. ${change.change_description} ${os.EOL}`;
           counter++;
           if(change.affected_paths.length > 0) {
               change.affected_paths.forEach((path) => {
                   message = `${message} \t - ${path} ${os.EOL}`;
               });
           }
       }
    });
    let select_questions = new Select({
       name: 'upgrade',
       message: message,
       choices: [
           UPGRADE_PROCEED,
           UPGRADE_CANCEL
       ]
    });

    //Ask the user to move forward with update, or cancel so they can run a backup.
    let response = undefined;
    try {
        response = await select_questions.run();
    } catch(err) {
        log.error('There was an error asking for an upgrade.');
        log.error(err);
        return false;
    }

    return response === UPGRADE_PROCEED;
}

module.exports = {
    forceUpdatePrompt
};