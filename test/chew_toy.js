const forge = require('node-forge');
generateKeys(function(err){
    if(err){
        console.err(err);
    }

})
function generateKeys(callback){
    let pki = forge.pki;
    let keys = pki.rsa.generateKeyPair(2048);
    let cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
// alternatively set public key from a csr
//cert.publicKey = csr.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    let attrs = [{
        name: 'commonName',
        value: 'harperdb.io'
    }, {
        name: 'countryName',
        value: 'US'
    }, {
        shortName: 'ST',
        value: 'Colorado'
    }, {
        name: 'localityName',
        value: 'Denver'
    }, {
        name: 'organizationName',
        value: 'HarperDB, Inc'
    }, {
        shortName: 'OU',
        value: 'HDB'
    }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{
        name: 'basicConstraints',
        cA: true,
        id: 'hdb_1.0'
    }, {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
    }, {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
        codeSigning: true,
        emailProtection: true,
        timeStamping: true
    }, {
        name: 'nsCertType',
        client: true,
        server: true,
        email: true,
        objsign: true,
        sslCA: true,
        emailCA: true,
        objCA: true
    }, {
        name: 'subjectAltName',
        altNames: [{
            type: 6, // URI
            value: 'http://example.org/webid#me'
        }, {
            type: 7, // IP
            ip: '127.0.0.1'
        }]
    }, {
        name: 'subjectKeyIdentifier'
    }]);

    cert.sign(keys.privateKey);

// convert a Forge certificate to PEM
    let pem = pki.certificateToPem(cert);
    fs.writeFile(hdb_properties.get('CERTIFICATE'), cert, function (err, data) {
        if (err) {
            winston.error(err);
            return callback(err);
        }
        fs.writeFile(hdb_properties.get('PRIVATE_KEY'), pem, function (err, data) {
            if (err) {
                winston.error(err);
                return callback(err);
            }
            return callback();

        });


    });


}