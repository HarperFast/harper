'use strict';
const lmdb = require('node-lmdb');
const environment_utility= require('./environmentUtility');

/**
 * This class is used to create the transaction & cursor objects needed to perform search on a dbi as well as a function to close both objects after use
 */
class TransactionCursor{
    /**
     * create the TransactionCursor object
     * @param {lmdb.Env} env - environment object to create the transaction & cursor from
     * @param {String} attribute - name of the attribute to create the cursor against
     */
    constructor(env, attribute) {
        this.dbi = environment_utility.openDBI(env, attribute);
        this.txn = env.beginTxn({ readOnly: true });
        this.cursor = new lmdb.Cursor(this.txn, this.dbi);
    }

    /**
     * function to close the read cursor & abort the transaction
     */
    close(){
        this.cursor.close();
        this.txn.abort();
    }
}

module.exports = TransactionCursor;