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

module.exports = {
    NodeObject,
    SubscriptionObject
};
