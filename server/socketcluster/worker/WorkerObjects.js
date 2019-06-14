"use strict";

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