"use strict";

class Node{
    /**
     *
     * @param {string} name
     * @param {string} host
     * @param {number} port
     * @param {Array.<NodeSubscription>} subscriptions
     */
    constructor(name, host, port, subscriptions){
        this.name = name;
        this.host = host;
        this.port = port;
        this.subscriptions = subscriptions;
    }
}

class NodeSubscription{
    /**
     *
     * @param {string} channel
     * @param {boolean} publish
     * @param {boolean} subscribe
     */
    constructor(channel, publish, subscribe){
        this.channel = channel;
        this.publish = publish;
        this.subscribe = subscribe;
    }
}

module.exports = {
    Node,
    NodeSubscription
};