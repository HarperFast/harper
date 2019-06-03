"use strict";

/**
 * This is meant as a central place to defined POJOs used by functions in the /bin/ directory.
 */

class HdbInfoInsertObject {
  constructor(id, data_version_num, hdb_version_num) {
      this.info_id = id;
      this.data_version_num = data_version_num;
      this.hdb_version_num = hdb_version_num;
  }
}

module.exports = {
    HdbInfoInsertObject : HdbInfoInsertObject
};