'use strict';

class LMDBTransactionObject{
    constructor(operation, records, original_records, user_name, timestamp) {
        this.operation = operation;
        this.records = records;
        this.original_records = original_records;
        this.user_name = user_name;
        this.timestamp = timestamp;
    }
}

module.exports = LMDBTransactionObject;