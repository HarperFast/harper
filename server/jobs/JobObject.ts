'use strict';;
import * as hdbTerm from '../../utility/hdbTerms.js';
import moment from 'moment';
import { v4 as uuidV4 } from 'uuid';

/**
 * This class represents a Job as it resides in the jobs table.
 */
class JobObject {
	constructor() {
		this.id = uuidV4();
		this.type = undefined;
		this.start_datetime = moment().valueOf();
		this.created_datetime = moment().valueOf();
		this.end_datetime = undefined;
		this.status = hdbTerm.JOB_STATUS_ENUM.CREATED;
		this.message = undefined;
		this.user = undefined;
		this.request = undefined;
	}
}

export default JobObject;
