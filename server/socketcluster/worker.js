'use strict';

const SCWorker = require('socketcluster/scworker');
const SCServer = require('./handlers/SCServer');
const log = require('../../utility/logging/harper_logger');
const NodeConnector = require('./connector/NodeConnector');
const promisify = require('util').promisify;
const fs = require('fs-extra');
const env = require('../../utility/environment/environmentManager');
env.initSync();
const HDB_QUEUE_PATH = env.getHdbBasePath() + '/schema/system/hdb_queue/';
const uuid = require('uuid/v4');
const json_2_csv = require('json-2-csv');

class Worker extends SCWorker{
    run(){
        this.registerWorkerHandlers();
        this.HDB_QUEUE_PATH = env.getHdbBasePath() + '/schema/system/hdb_queue/';
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.publishInMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_HANDSHAKE_SC, this.handshakeSCMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_OUT, this.publishOutMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_SUBSCRIBE, this.subscribeMiddleware.bind(this));
        let sc_server = new SCServer(this);

        this.hdb_workers = [];

        this.fs_channel_map = {};


        this.exchange_get = promisify(this.exchange.get).bind(this.exchange);
        this.exchange_set = promisify(this.exchange.set).bind(this.exchange);
        this.exchange_add = promisify(this.exchange.add).bind(this.exchange);
        this.exchange_get('hdb_worker').then(data => {
            console.log(data);
            if(typeof data === 'object') {
                this.hdb_workers = Object.keys(data);
            }
        });


        if(this.isLeader){
            //new NodeConnector(require('./connector/node'), this);
        }
    }


    subscribeMiddleware(req, next){
        if(this.hdb_workers.indexOf(req.channel) >= 0 && req.channel !== req.socket.id){
            return next('cannot connect to another socket\'s channel');
        }

        return next();
    }

    /**
     * here we want to block any unauthed clients and destroy them.  also mark a message with the originator client so we don't send it back
     * @param req
     * @param next
     */
    publishInMiddleware(req, next){
        try{
            this.publishInValidation(req);

            //if the channel is harperdb child connection we immediatley send it on
            if(this.hdb_workers.indexOf(req.channel) >= 0){
                return next();
            }

            if(req.data.__transacted === undefined){
                //send to worker
                this.logPendingTransaction(req.channel, req.data).then(()=>{
                    this.sendTransactionToWorker(req.channel, req.data);
                    //squash the message from continuing to publish in
                    return next(true);
                });
            }

            delete req.data.__transacted;
            delete req.data.__id;
            this.logTransaction(req.channel, req.data).then(()=>{
                next();
            });
        } catch(e){
            console.error(e);
            return next(e);
        }
    }

    async checkFSChannelMap(channel){
        if(this.fs_channel_map[channel] === undefined){
            await fs.mkdirp(HDB_QUEUE_PATH + channel + '/' + channel);
            this.fs_channel_map[channel] = fs.createWriteStream(HDB_QUEUE_PATH + channel, {flags:'a'});
        }
    }

    async logPendingTransaction(channel, transaction){
        await this.checkFSChannelMap(channel);

        let transaction_csv = await json_2_csv.json2csvAsync(transaction, {prependHeader: false, keys: ['__id', 'timestamp', 'operation', 'records']}) + '\r\n';
        this.fs_channel_map[channel].write(transaction_csv);
    }

    async logTransaction(channel, transaction){
        await this.checkFSChannelMap(channel);

        let transaction_csv = await json_2_csv.json2csvAsync(transaction, {prependHeader: false, keys: ['timestamp', '__id', 'operation', 'records']}) + '\r\n';
        this.fs_channel_map[channel].write(transaction_csv);
    }


    sendTransactionToWorker(channel, data){
        if(channel.indexOf('internal:') < 0) {
            channel = channel.split(':');
            data.schema = channel[0];
            data.table = channel[1];
        }
        let rand = Math.floor(Math.random() * this.hdb_workers.length);
        let random_worker = this.hdb_workers[rand];

        this.exchange.publish(random_worker, data);
    }

    /**
     * intended to validate the
     * @param req
     * @returns {*}
     */
    publishInValidation(req){
        //only allow JSON object sent in
        if(typeof req.data !== 'object' || Array.isArray(req.data)){
            throw new Error('data must be an object');
        }

        //refuse unauthorized sockets
        if(req.socket.authState === req.socket.UNAUTHENTICATED){
             throw new Error('not authorized');
        }

        if(!req.data.timestamp) {
            //add / change tghe timestamp
            req.data.timestamp = Date.now();
        }

        if(!req.data.__id) {
            req.data.__id = uuid();
        }

        if(!req.data.__originator) {
            //the __originator attribute is added so we can filter out sending back the same object to the sender
            req.data.__originator = req.socket.id;
        }
    }


    publishOutMiddleware(req, next){
        if(req.socket.authState === req.socket.UNAUTHENTICATED){
            return next(new Error('not authorized'));
        }

        if(this.hdb_workers.indexOf(req.channel) >= 0){
            return next();
        }

        //if the data has not been transacted and if the data did not originated from the socket we do not publish out
        if(req.data.__originator !== req.socket.id){
            return next();
        }
    }

    /**
     * this middleware will be used to handle the authentication.  we will grab req.socket.request.url which is where users will send their credentials
     * @param req
     * @param next
     */
    handshakeSCMiddleware(req, next){
        console.log('sc shaking hands');

        req.socket.emit('login', 'send login credentials', (error, credentials)=>{
            if(error){
                return console.error(error);
            }
            console.log(credentials);
            if(!credentials || !credentials.username || !credentials.password){
                return console.error('Invalid credentials');
            }

            //right now setting a dummy token, we do need to handle this scenario: https://github.com/SocketCluster/socketcluster/issues/343
            req.socket.setAuthToken({username: 'hdb'}, {expiresIn: 2000});
        });

        next();
    }

    /**
     * registers this worker to it's event handlers
     */
    registerWorkerHandlers(){
        this.on('error', this.errorHandler);
        this.on('notice', this.noticeHandler);
        this.on('exit', this.exitHandler);
        this.on('ready', this.readyHandler);

    }

    /**
     * This gets triggered when fatal error occurs on this worker.
     * @param error
     */
    errorHandler(error){
        log.error(error);
    }

    /**
     * A notice carries potentially useful information but isn't quite an error.
     * @param notice
     */
    noticeHandler(notice){
        log.warn(notice);
    }

    /**
     * Happens when this worker exits (sometimes due to error).
     */
    exitHandler(){
        log.fatal('Worker ' + this.id + ' is about to crash');
    }

    /**
     *This signals that the worker is ready to accept requests from users.
     */
    readyHandler(){
        console.log('Worker ' + this.id + ' is ready to accept requests');
    }

    /**
     * Emitted when the master process sends a message to this worker. The handler function accepts two arguments;
     * the first is the data which was sent by the master process, the second is a respond callback function which you can call to respond to the event using IPC.
     * The respond function should be invoked as respond(error, data); it is recommended that you pass an instance of the Error object as the first argument; if you don't want to send back an error,
     * then the first argument should be null: respond(null, data). See sendTransactionToWorker(...) method in SocketCluster (master) API for details on how to send a message to a worker
     * from the master process (and how to handle the response from the worker).
     * @param data
     * @param callback
     */
    masterMessageHandler(data, callback){

    }
}

new Worker();