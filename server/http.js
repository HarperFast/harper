

const cluster = require('cluster');
const numCPUs = 3;

if (cluster.isMaster) {
    console.log(`Master ${process.pid} is running`);

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`worker ${worker.process.pid} died`);
    });
} else {
    const http = require('http'),
        insert=require('../data_layer/insert');
    const requestHandler = (request, response) => {
        try {
            var body = ""; // request body

            request.on('data', function (data) {
                body += data.toString(); // convert data to string and append it to request body
            });

            request.on('end', function () {
                let ops_object = JSON.parse(body);
                var rand_int = Math.floor(Math.random() * (10000000 - 1)) + 1;
                ops_object.id = ops_object.id + rand_int;
                ops_object.first_name = ops_object.first_name + rand_int;
                ops_object.last_name = ops_object.last_name + rand_int;
                insert.insert(ops_object, function (err, data) {
                    if (err) {
                        console.error(err);
                        response.writeHead(500, {
                            'Content-Length': err.length,
                            'Content-Type': 'application/json'
                        });
                        response.end('' + err);
                        return;
                    }

                    response.writeHead(200, {
                        'Content-Type': 'application/json'
                    });
                    response.end(data);
                    return;
                });
                return;
            });
        } catch (e) {
            console.error(e);
        }


    }

    const server = http.createServer(requestHandler)

    server.listen(5299, (err) => {
        if (err) {
            return console.log('something bad happened', err)
        }


    });

}