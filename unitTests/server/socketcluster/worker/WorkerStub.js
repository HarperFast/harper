"use strict";

const WORKER_NAME = 'asdfesd';

class WorkerStub {
    constructor() {
        this['exchange'] = {};
        this.publish_called = false;
        this.exchange_set_called = false;
        this.exchange.publish = (channel, req) => {
            console.log('Called publish');
            this.publish_called = true;
        };
        this.exchange_set= (topic, data) => {
           console.log('Called worker exchange_set');
            this.exchange_set_called = true;
        };
        this.id = 0;
        this.hdb_workers = [WORKER_NAME];
        this.hdb_users = {};
        this.scServer = {
            clients: {
                "ASDLKFJSDFLAKD": {
                    id: 'testid',
                    remoteAddress: 'outside',
                    remotePort: '33333',
                    state: 'connected',
                    exchange: {
                        _channels: {
                            "dev:dog": {
                                name: 'dev:dog',
                                state: 'subscribed'
                            },
                            "dev:breed": {
                                name: 'dev:dog',
                                state: 'subscribed'
                            },
                            "hdb_internal:create_schema": {
                                name: 'dev:dog',
                                state: 'subscribed'
                            }
                        }
                    }
                }
            }
        };
        this.node_connector = {
            connections: {
                clients: {
                    "https://localhost:12345/socketcluster": {
                        options: {
                            hostname: 'Im a test',
                            post: '12345',
                            state: 'connected'
                        },
                        additional_info: {
                            subscriptions: {
                                "server_name": "truck_1",
                                "client_name": "server",
                                "subscriptions": [
                                    {
                                        "channel": "dev:dog",
                                        "publish": true,
                                        "subscribe": true
                                    },
                                    {
                                        "channel": "dev:breed",
                                        "publish": false,
                                        "subscribe": true
                                    },
                                    {
                                        "channel": "hdb_internal:create_schema",
                                        "publish": true,
                                        "subscribe": true
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        };
    }
}

module.exports = {
    WorkerStub
};