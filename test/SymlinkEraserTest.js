const settings = require('settings'),
      search = require('../data_layer/search'),
      net = require('net');


    test();

function test(){
     var search_obj = {};
     search_obj.schema = 'dev';
     search_obj.table = 'person';
     search_obj.hash_attribute = 'id';
     search_obj.search_attribute = 'id';
     search_obj.search_value = "*"
     search_obj.get_attributes = ['first_name', 'last_name', 'id'];

    search.searchByValue(search_obj, function (err, data) {
        if (err){
            console.error(err);
            return;
        }

        var write_object = {
            "write":{
            "table":"person",
                "schema":"dev",
                "hash_attribute":"id",
                "records":[]
        }

        }

        function getRandomInt(min, max) {
            min = Math.ceil(min);
            max = Math.floor(max);
            return Math.floor(Math.random() * (max - min)) + min;
        }

        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);
        write_object.write.records.push(data[getRandomInt(0, data.length -1)]);

        var test_obj = {}
        test_obj.date = new Date().getTime();
        test_obj.write = write_object.write;
        let client = new net.Socket();

        try {
            client.connect(settings.ERASER_PORT, settings.HDB_ADDRESS, function () {
                //console.log('Connected');
                client.write(JSON.stringify(test_obj));
                return;
            });
        }catch(e){
            console.error(e);
            return;
        }

        client.on('data', function (data) {
            console.log(data);
            return;
        });

        client.on('close', function () {
            //console.log('Connection closed');
            return;
        });

        client.on('error', function (err) {
            console.error(err);
            return;
        });


    });


}