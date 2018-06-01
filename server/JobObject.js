"use strict";

const hdb_term = require('../utility/hdbTerms');
const moment = require('moment');
const uuidV4 = require('uuid/v4');

/**
 * This class represents a Job as it resides in the jobs table.
 */
class JobObject {
    constructor() {
        this.id = uuidV4();
        this.type = undefined;
        this.job_body = undefined;
        this.start_datetime = moment().valueOf();
        this.created_datetime = moment().valueOf();
        this.end_datetime = undefined;
        this.status = hdb_term.JOB_STATUS_ENUM.CREATED;
        this.message = undefined;
        this.user = undefined;
    }
}

module.exports = JobObject;