"use strict";

/**
 *  Here we defined objects related to the worker that may need to be passed around various modules
 */

/**
 * Defines how a subscription is stored in the worker.
 */
class SubscriptionDefinition {
    constructor(topic, is_subscribed, is_watching) {
        this.topic = topic;
        //TODO: These may not be needed.  Is there a case where we would subscribe but not watch?  Or vice versa?
        this.is_subscribed = is_subscribed;
        this.is_watching = is_watching;
    }
};

module.exports = {
    SubscriptionDefinition
};