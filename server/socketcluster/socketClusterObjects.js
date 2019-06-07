"use strict";


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
     * @param {Boolean} start_timestamp
     * @param {Boolean} end_timestamp
     */
    constructor(channel, start_timestamp, end_timestamp){
        this.channel = channel;
        this.start_timestamp = start_timestamp;
        this.end_timestamp = end_timestamp;
    }
}

module.exports = {
    NodeObject,
    SubscriptionObject,
    CatchupObject
};
