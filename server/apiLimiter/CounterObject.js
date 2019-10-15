"use strict";

class CounterObject {
    constructor(count, expires_at_unix_tick) {
        this.count = count;
        this.expires_at = expires_at_unix_tick;
    }
}

module.exports = CounterObject;