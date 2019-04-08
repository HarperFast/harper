
class SocketConnector{
    constructor(socket_client, name, hostname, port, credentials){
        this.name = name;
        this.socket = this.init(socket_client, hostname, port, credentials);
        this.disconnect_timestamp = null;
    }

    init(socket_client, hostname, port, credentials) {
        this.socket = socket_client.create({
            hostname: hostname,
            port: port,
            rejectUnauthorized: false, // Only necessary during debug if using a self-signed certificate
            autoConnect:true,
            connectTimeout: 10000, //milliseconds
            ackTimeout: 10000, //milliseconds
            autoReconnectOptions: {
                initialDelay: 1000, //milliseconds
                randomness: 5000, //milliseconds
                multiplier: 1.5, //decimal
                maxDelay: 30000 //milliseconds
            }
        });

        this.socket.on('incoming_data', (data, res)=>{
            console.log(data);
        });

        this.socket.on('error', err =>{
            console.error(err);
        });

        this.socket.on('connect', status =>{
            this.disconnect_timestamp = null;
            console.log(status);
        });

        this.socket.on('disconnect', status =>{
            this.disconnect_timestamp = Date.now();
            console.log(status);
        });

        this.socket.on('login', (data, res)=>{
            res(null, credentials);
        });

        this.socket.on('authStateChange', state_change_data =>{
            console.log(state_change_data);
        });
    }

    addEventListener(event, listener){
        this.socket.addEventListener(event, listener);
    }

    subscribe(channel, watcher){
        this.socket.subscribe(channel, {waitForAuth: true}).watch(watcher);
    }

    publish(channel, data, handler){
        this.socket.publish(channel, data, handler);
    }

    status(){
        return {
            active: this.socket.active,
            state: this.socket.state,
            auth_state: this.socket.authState
        }
    }

    subscriptions(){
        return Object.keys(this.socket.subscriptions(true));
    }

    unsubscribe(channel){
        this.socket.unsubscribe(channel);
    }

    destroy(){
        this.socket.destroy();
    }
}

module.exports = SocketConnector;