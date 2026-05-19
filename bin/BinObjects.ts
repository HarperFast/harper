'use strict';

/**
 * This is meant as a central place to defined POJOs used by functions in the /bin/ directory.
 */

export class HdbInfoInsertObject {
	info_id: any;
	data_version_num: any;
	hdb_version_num: any;
	constructor(id, dataVersionNum, hdbVersionNum) {
		this.info_id = id;
		this.data_version_num = dataVersionNum;
		this.hdb_version_num = hdbVersionNum;
	}
}
