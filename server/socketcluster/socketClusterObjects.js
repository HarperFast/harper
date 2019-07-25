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
     * @param {Number} milis_since_connected
     */
    constructor(channel, milis_since_connected){
        this.channel = channel;
        this.milis_since_connected = milis_since_connected;
    }
}

module.exports = {
    NodeObject,
    SubscriptionObject,
    CatchupObject
};
