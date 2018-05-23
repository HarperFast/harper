"use strict";

const uuidV4 = require('uuid/v4');
const insert = require('../data_layer/insert');
const search = require('../data_layer/search');
const search_object = require('../data_layer/SearchObject');
const hdb_terms = require('../utility/hdbTerms');
const Job_Object = require('./JobObject');
const log = require('../utility/logging/harper_logger');
const Insert_Object = require('../data_layer/InsertObject');
const hdb_util = require('../utility/common_utils');
const {promisify} = require('util');

//Promisified functions
const p_search_by_value = promisify(search.searchByValue);
const p_insert = promisify(insert.insert);

module.exports = {
    addJob: addJob
};

/**
 * Add a job to the job schema.
 * @param job - job descriptor defined in the endpoint.
 * @returns {Promise<*>}
 */
async function addJob(job) {
    if(hdb_util.isEmptyOrZeroLength(job) || hdb_util.isEmptyOrZeroLength(job.job_type)) {
        log.info(`job parameter is invalid`);
        return false;
    }

    // Check for valid job type.
    if(!hdb_terms.JOB_TYPE_ENUM[job.job_type]) {
	    log.info(`invalid job type specified: ${job.job_type}.`);
	    return false;
    }

    let new_job = new Job_Object(uuidV4(), job.job_type, '', job.hdb_user);
    let search_obj = new search_object(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.JOB_TABLE_NAME, 'id', new_job.id, 'id', 'id');
    let found_job = await p_search_by_value(search_obj);
    //TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
    let found_values = (Array.isArray(found_job) ? found_job : Object.keys(found_job));
    // It is highly unlikely that we will ever get into this, as a UUID duplicate is very rare.  Just in case we
    // do have a collision, we regenerate an ID and search again.  The odds of 2 collisions are so astronomically high
    // that we will just throw an error assuming there is bad input somewhere.
    if(found_values && found_values.length > 0) {
        new_job.id = uuidV4();
        found_job = await p_search_by_value(search_obj);
	    //TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
	    found_values = (Array.isArray(found_job) ? found_job : Object.keys(found_job));
        if(found_values && found_values.length > 0) {
            log.error('Error creating a job, could not find a unique job id.');
            return false;
        }
    }

    let insert_object = new Insert_Object('insert', hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.JOB_TABLE_NAME, 'id', [new_job]);
    return await p_insert(insert_object);
}