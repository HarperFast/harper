"use strict";

const hdb_term = require('../utility/hdbTerms');
const moment = require('moment');
const uuidV4 = require('uuid/v4');
/**
 * This class represents a Job as it resides in the jobs table.
 */
class JobObject {
    constructor(job_type, message, user) {
        this.id = uuidV4();
        this.type = job_type;
        this.job_body = '';
        this.start_datetime = moment().valueOf();
        this.created_datetime = moment().valueOf();
        this.end_datetime = undefined;
        this.status = hdb_term.JOB_STATUS_ENUM.CREATED;
        this.message = message;
        this.user = user.username;
    }
}

module.exports = JobObject;