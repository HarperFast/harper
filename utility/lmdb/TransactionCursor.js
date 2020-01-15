'use strict';
const lmdb = require('node-lmdb');
const data_stores= require('./dataStores');

class TransactionCursor{
    constructor(env, attribute) {
        this.dbi = data_stores.openDBI(env, attribute);
        this.txn = env.beginTxn({ readOnly: true });
        this.cursor = new lmdb.Cursor(this.txn, this.dbi);
    }

    close(){
        this.cursor.close();
        this.txn.abort();
    }
}

module.exports = TransactionCursor;