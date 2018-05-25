"use strict";

const hdb_term = require('../utility/hdbTerms');
const moment = require('moment');

class JobObject {
    constructor(id, job_type, message, user) {
        this.id = id;
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