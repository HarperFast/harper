"use strict";

const log = require('../logging/harper_logger');
const inquirer = require('inquirer');
const os = require('os');
const upgrade = require('../../bin/upgrade');

async function forceUpdatePrompt(old_version_string, new_version_string) {
    // pull directive changes
    let changes = upgrade.listDirectiveChanges(old_version_string, new_version_string);
    let counter = 1;
    let message = 'HarperDB has been recently updated, we need to complete the update process.  If a backup of your data has not been created, cancel this process and backup.  The following data will be affected:';
    message = message + os.EOL;
    changes.forEach((change) => {
       if(change.change_description) {
           message = `${message} ${counter}. ${change.change_description} ${os.EOL}`;
           if(change.affected_paths.length > 0) {
               change.affected_paths.forEach((path) => {
                   message = `${message} \t - ${path} ${os.EOL}`;
               });
           }
       }
    });
    //1.  Inform the user they need to run update, present filesystem changes gathered from upgrade directives
    let questions = [
        {
            type: 'expand',
            name: 'updateResponse',
            message: message,
            choices: [
                {
                    key: 'y',
                    name: 'Run Update',
                    value: true
                },
                {
                    key: 'n',
                    name: 'Cancel Update',
                    value: false
                }
            ]
        }
    ];
    //2.  Ask the user to move forward with update, or cancel so they can run a backup.
    let response = await inquirer.prompt(questions);
    console.log(`Response is: ${JSON.stringify(response)}`);
    //3.  Run the upgrade directives
    if(!response || !response.updateResponse) {
        return false;
    }
    return true;
}

module.exports = {
    forceUpdatePrompt
};