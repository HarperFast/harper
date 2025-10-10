'use strict';

/**
 * This is meant as a central place to defined POJOs used by functions in the /bin/ directory.
 */

class HdbInfoInsertObject {
	constructor(id, dataVersionNum, hdbVersionNum) {
		this.info_id = id;
		this.data_version_num = dataVersionNum;
		this.hdb_version_num = hdbVersionNum;
	}
}

module.exports = {
	HdbInfoInsertObject,
};
