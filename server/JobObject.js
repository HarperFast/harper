"use strict";

const hdb_term = require('../utility/hdbTerms');

class JobObject {
    constructor(id, job_type, message, user) {
        this.id = id;
        this.type = job_type;
        this.job_body = '';
        this.start_time = undefined;
        this.end_time = undefined;
        this.status = hdb_term.JOB_STATUS_ENUM.CREATED;
        this.message = message;
        this.user = user;
    }
}

module.exports = JobObject;