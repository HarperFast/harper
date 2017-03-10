var InsertListener = require('./listeners/insertListener.js');

var insert = {
    schema:'dev',
    table:'person',
    hash_attribute:'id'
};

var listener = new InsertListener(insert);
