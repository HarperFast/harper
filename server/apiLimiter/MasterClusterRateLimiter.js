"use strict";

const log = require('../../utility/logging/harper_logger');
const crypto = require('crypto');
const registration_handler = require('../../utility/registration/registrationHandler');
const path = require('path');
const fs = require('fs-extra');
const CounterObject = require('./CounterObject');
const terms = require('../../utility/hdbTerms');
const {inspect} = require('util');
const os = require('os');
/*
* This class should be used by hdb_express to store the rate limits whenever needed.
*/
let fingerprint = undefined;
const HOME_HDB_PATH = path.join(os.homedir(), terms.HDB_HOME_DIR_NAME);

/**
 * Store the curr api count to path
 * @param count - A CounterObject type with the count to store
 * @param path - The path to store to
 * @returns {Promise<void>}
 */
async function saveApiCallCount(count, loc) {
    try {
        let finger = await registration_handler.getFingerprint();
        console.log("fingerprint:" + inspect(finger));
        let cipher = crypto.createCipher('aes192', finger);
        let encrypted_exp = cipher.update(JSON.stringify(count), 'utf8', 'hex');
        encrypted_exp += cipher.final('hex');

        let backup_loc = path.join(`/tmp`, finger, `.${finger}1`);

        await fs.writeFile(loc, encrypted_exp, {encoding: 'utf8', mode: terms.HDB_FILE_PERMISSIONS}).catch((err) => {
            log.error(`Error writing count file to ${loc}`);
            log.error(err);
            throw new Error('There was an error writing the count');
        });

        await fs.outputFile(backup_loc, encrypted_exp, {
            encoding: 'utf8',
            mode: terms.HDB_FILE_PERMISSIONS
        });
    } catch(err) {
        log.error('Error saving calls');
        log.error(err);
    }
}

function readCFile(loc, fingerprint) {
    try {
        let result = fs.readFileSync(loc);
        let decipher = crypto.createDecipher('aes192', fingerprint);
        let decrypted = decipher.update(result.toString(), 'hex', 'utf8');
        decrypted.trim();
        decrypted += decipher.final('utf8');

        if (isNaN(decrypted)) {
            let count_obj = JSON.parse(decrypted);
            return count_obj;
        }
        fs.unlink(loc);
    } catch(err) {
        log.error('Error reading count');
        return 0;
    }
}

async function readLimitFiles() {
    let vals = [];
    let fingerprint = await registration_handler.getFingerprint();
    try {
        let val1 = await readCFile(path.join(HOME_HDB_PATH, terms.LIMIT_COUNT_NAME), fingerprint);
        if(val1 && val1.count) {
            vals.push(val1);
        }
    } catch (err) {
        log.error(err);
    }

    try {
        let val2 = await readCFile(path.join(`/tmp`, fingerprint, `.${fingerprint}1`), fingerprint);
        if(val2 && val2.count) {
            vals.push(val2);
        }
    } catch (err) {
        log.error(err);
    }
    let largest;
    if(vals.length > 0) {
        largest = vals[0];
        vals.forEach((val) => {
            if (val && val.count && val.count > largest.count) {
                largest = val;
            }
        });
    }
    return largest;
}

module.exports = {
    saveApiCallCount,
    readLimitFiles
};

