const os = require('os'),
    mkdirp = require('mkdirp'),
    fs = require('fs'),
    http = require('http'),
    tar = require('tar-fs'),
    request = require("request");
PropertiesReader = require('properties-reader'),
    winston = require('winston'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


winston.configure({
    transports: [
        new (winston.transports.File)({filename: 'error.log'})
    ]
});

module.exports = {
    upgrade: upgrade
};

function upgrade() {

    let os = findOs();
    if (!os) {
        return console.error('You are attempting to upgrade HarperDB on an unsupported operating system');


    }

    getBuild(os, function (err, build) {
        if (err) {
            return console.error(err);
        }
        fs.readFile(hdb_properties.get('PROJECT_DIR') + '/package.json', 'utf8', function (err, package_json) {
            if (err) {
                winston.error(err);
                return console.error(err);
            }

            if (JSON.parse(package_json).version >= build[0].product_version) {
                return console.warn('HarperDB already up to date on ' + JSON.parse(package_json).version);
            }


            executeUpgrade(build[0]);

        });


    });


}


function getBuild(os, callback) {

    let options = {
        method: 'POST',
        url: 'http://products.harperdb.io:9925/',
        headers:
            {
                'cache-control': 'no-cache',
                authorization: 'Basic aGRiX2xtczpWQFRHVTN3TUxBSEFFNiluVmJCcWdLb25CYnd5S05eOQ==',
                'content-type': 'application/json'
            },
        body:
            {
                operation: 'sql',
                sql: "select public_path, product_version,path, product, os, " +
                "status from hdb_lms.versions where status = 'active' AND os = '" + os + "'  ORDER BY product_version desc"
            },
        json: true
    };

    request(options, function (error, response, body) {
        if (error) {
            winston.error(error);
            return callback(error);
        }
        return callback(null, body);
    });

}

function findOs() {
    if (os.arch() === 'arm' || os.arch() === 'arm64') {
        //armv7l
        //armv6l
        switch (os.release()) {
            case "armv7l":
                return 'ARM 7'
                break;
            case "armv6l":
                return 'ARM 6';
                break;
            default:
                return null;
                break;
        }

    }

    switch (os.platform()) {
        case "darwin":
            return 'Mac';
            break;
        case "linux":
            return 'Linux';
            break;
        default:
            return null;
    }
}

function executeUpgrade(build) {
    var CLI = require('clui'),
        Spinner = CLI.Spinner;

    var countdown = new Spinner('Upgrading HarperDB ', ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);

    countdown.start();

    let upgradeFolder = hdb_properties.get('HDB_ROOT') + '/upgrade/' + Date.now() + '/';

    mkdirp(upgradeFolder);
    var path_tokens = build.public_path.split(':');
    var host = path_tokens[0];
    var port = path_tokens[1].split('/')[0];
    var path = path_tokens[1].split('/')[1];
    var options = {
        "method": "GET",
        "hostname": host,
        "port": port,

        "path": "/" + path

    };

    var file = fs.createWriteStream(upgradeFolder + '' + path);
    http.get(options).on('response', function (response) {
        response.pipe(file);
        response.on('end', function () {
            var stream = fs.createReadStream(upgradeFolder + '' + path);
            stream.pipe(tar.extract(upgradeFolder));
            stream.on('error', function (err) {
                winston.error(err);
                return console.error(err);
            });
            stream.on('close', function () {
                fs.unlink(hdb_properties.get('PROJECT_DIR') + '/bin/harperdb', function (err) {
                    if (err) {
                        winston.error(err);
                        return console.error(err);
                    }
                    fs.rename(upgradeFolder + 'HarperDB/bin/harperdb', hdb_properties.get('PROJECT_DIR') + '/bin/harperdb', function (err) {
                        if (err) {
                            winston.error(err);
                            return console.error(err);
                        }
                        fs.rename(upgradeFolder + 'HarperDB/package.json', hdb_properties.get('PROJECT_DIR') + '/package.json', function (err) {
                            if (err) {
                                winston.error(err);
                                return console.error(err);
                            }
                            fs.rename(upgradeFolder + 'HarperDB/user_guide.html', hdb_properties.get('PROJECT_DIR') + '/user_guide.html', function (err) {
                                if (err) {
                                    winston.error(err);
                                    return console.error(err);
                                }
                                countdown.stop();
                                console.log('HarperDB has been upgraded to ' + build.product_version);

                            });
                        });
                    });


                });

            });

        });
    });
}


