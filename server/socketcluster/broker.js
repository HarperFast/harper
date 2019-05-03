'use strict';

const SCBroker = require('socketcluster/scbroker');

class Broker extends SCBroker {
    run() {
        this.on('subscribe', this.subscribeHandler.bind(this));
        this.on('unsubscribe', this.unsubscribeHandler);
        this.on('publish', this.publishHandler);
        this.on('masterMessage', this.masterMessageHandler);
    }

    /**
     * This gets triggered whenever a SocketCluster worker subscribes to a channel. When a worker subscribes to a channel,
     * it means that at least one client-side socket which is bound to that worker has asked to subscribe to that channel.
     * A worker will not try to subscribe to the channel again if it is already subscribed to it.

     For the purpose of scaling SocketCluster across multiple machines, if you see this event triggered for a particular channel,
     then you know that the current broker is interested in that channel,
     so you can use an MQTT, AMQP, or Redis client of your choice to create a matching channel subscription on a remote Pub/Sub cluster -
     This allows you to extend the subscription to an external pub/sub service.
     * @param channel
     */
    subscribeHandler(channel){
        console.log('broker channel subscribed ' + channel);
    }

    /**
     * This event will get triggered when a worker unsubscribes from a channel on the current broker.
     * A worker will unsubscribe itself from a channel when it no longer has any client-side sockets which want to be subscribed to that channel.
     * A worker will only unsubscribe to a channel if it is subscribed to it.

     Like the 'subscribe' event described above, you can use this event to unsubscribe your broker process from a particular channel on a remote Pub/Sub cluster.
     * @param channel
     */
    unsubscribeHandler(channel){
        console.log('broker channel unsubscribed ' + channel);
    }

    /**
     * This event will be emitted whenever a worker publishes data to a particular channel on the current broker.
     * The worker may publish data to a channel on a broker when one of its client-side sockets asks to publish to that channel or when you call
     * worker.exchange.publish(...) from the worker process.
     * Note that if your SC instance has multiple brokers, then each broker will be responsible for a subset of all available channels within SC.
     * @param channel
     * @param data
     */
    publishHandler(channel, data){
        console.log(`broker received data on channel '${channel}': `, data);
    }

    masterMessageHandler(data, callback){
        console.log('data from master: ', data);
    }
}

new Broker();