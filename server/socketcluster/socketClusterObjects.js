"use strict";
const terms = require('../../utility/hdbTerms');

class NodeObject{
    /**
     *
     * @param {string} name
     * @param {string} host
     * @param {string} port
     * @param {Array.<SubscriptionObject>} subscriptions
     */
    constructor(name, host, port, subscriptions){
        this.name = name;
        this.host = host;
        this.port = port;
        this.subscriptions = subscriptions;
    }
}


class SubscriptionObject{
    /**
     *
     * @param {string} channel
     * @param {Boolean} publish
     * @param {Boolean} subscribe
     */
    constructor(channel, publish, subscribe){
        this.channel = channel;
        this.publish = publish;
        this.subscribe = subscribe;
    }
}

class CatchupObject{
    /**
     *
     * @param {string} channel
     * @param {Number} milis_since_connected
     */
    constructor(channel, milis_since_connected){
        this.channel = channel;
        this.milis_since_connected = milis_since_connected;
    }
}

class RotatingFileWriteStreamOptionsObject{
    /**
     *
     * @param filename
     * @param frequency
     * @param size
     * @param max_logs
     * @param audit_file
     */
    constructor(filename, frequency, size, max_logs, audit_file){
        this.filename = filename;
        this.frequency = frequency;
        this.size = size;
        this.verbose = false;
        this.max_logs = max_logs;
        this.audit_file = audit_file;
        this. file_options = {
            flags: 'a',
                mode: terms.HDB_FILE_PERMISSIONS
        };
    }
}

module.exports = {
    NodeObject,
    SubscriptionObject,
    CatchupObject,
    RotatingFileWriteStreamOptionsObject
};
