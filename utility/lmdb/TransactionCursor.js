'use strict';
const lmdb = require('node-lmdb');
const environment_utility= require('./environmentUtility');

class TransactionCursor{
    constructor(env, attribute) {
        this.dbi = environment_utility.openDBI(env, attribute);
        this.txn = env.beginTxn({ readOnly: true });
        this.cursor = new lmdb.Cursor(this.txn, this.dbi);
    }

    close(){
        this.cursor.close();
        this.txn.abort();
    }
}

module.exports = TransactionCursor;