'use strict';

/**
 * This is meant as a central place to defined POJOs used by functions in the /bin/ directory.
 */

export class HdbInfoInsertObject {
	info_id: string;
	data_version_num: number;
	hdb_version_num: number;
	constructor(id: string, dataVersionNum: number, hdbVersionNum: number) {
		this.info_id = id;
		this.data_version_num = dataVersionNum;
		this.hdb_version_num = hdbVersionNum;
	}
}
