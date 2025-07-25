#!/usr/bin/env node

/**
 * Generate test certificates for OCSP testing using Harper's existing CA
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

const OUTPUT_DIR = path.join(__dirname, 'generated');
const OCSP_PORT = process.env.OCSP_PORT || 8888;

// Harper connection details - use standard env vars from integration tests
const HARPER_URL = process.env.HARPER_URL || 'http://localhost:9925';
const HARPER_USER = process.env.HDB_ADMIN_USERNAME || 'admin';
const HARPER_PASS = process.env.HDB_ADMIN_PASSWORD || 'password';

async function harperQuery(operation) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64');
    const data = JSON.stringify(operation);
    
    const url = new URL(HARPER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 9925,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Content-Length': data.length
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getHarperCA() {
  console.log('Fetching Harper\'s CA from database...');
  
  const result = await harperQuery({
    operation: 'search_by_conditions',
    database: 'system',
    table: 'hdb_certificate',
    get_attributes: ['*'],
    conditions: [{
      search_attribute: 'is_authority',
      search_type: 'equals',
      search_value: true
    }]
  });
  
  if (!result || result.length === 0) {
    throw new Error('No CA found in Harper database');
  }
  
  // Get the first CA (should be Harper's self-generated CA)
  const ca = result[0];
  console.log(`Found CA: ${ca.name}`);
  console.log(`Private key file: ${ca.private_key_name}`);
  
  return ca;
}

async function generateOCSPCerts() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  try {
    // Step 1: Get Harper's CA
    const ca = await getHarperCA();
    
    // Save CA certificate for convenience
    const caCertPath = path.join(OUTPUT_DIR, 'harper-ca.crt');
    fs.writeFileSync(caCertPath, ca.certificate);
    console.log(`\nCA certificate saved to: ${caCertPath}`);
    
    // Step 2: Find CA private key
    const harperKeysDir = path.join('/Users/nathan/hdb/keys'); // Adjust path as needed
    const caKeyPath = path.join(harperKeysDir, ca.private_key_name);
    
    if (!fs.existsSync(caKeyPath)) {
      console.error(`\nERROR: CA private key not found at: ${caKeyPath}`);
      console.error('Please check the path to Harper\'s keys directory');
      return;
    }
    
    console.log(`Using CA private key from: ${caKeyPath}`);
    
    // Step 3: Generate OCSP responder certificate
    console.log('\nGenerating OCSP responder certificate...');
    const ocspKeyPath = path.join(OUTPUT_DIR, 'ocsp.key');
    const ocspCertPath = path.join(OUTPUT_DIR, 'ocsp.crt');
    
    execSync(`openssl genrsa -out ${ocspKeyPath} 2048`);
    execSync(`openssl req -new -key ${ocspKeyPath} -out ${OUTPUT_DIR}/ocsp.csr -subj "/CN=OCSP Responder/O=Harper OCSP Test"`);
    
    // First, extract the Subject Key Identifier from the CA certificate
    const caDetails = execSync(`openssl x509 -in ${caCertPath} -text -noout`).toString();
    let skiMatch = caDetails.match(/X509v3 Subject Key Identifier:\s*\n\s*([A-F0-9:]+)/i);
    
    // OCSP responder extensions
    let ocspExt = `[v3_ocsp]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = OCSPSigning
subjectKeyIdentifier = hash`;
    
    // Always use keyid,issuer format - OpenSSL will extract the keyid from the CA cert
    ocspExt += `\nauthorityKeyIdentifier = keyid,issuer`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, 'ocsp.ext'), ocspExt);
    
    execSync(`openssl x509 -req -in ${OUTPUT_DIR}/ocsp.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${ocspCertPath} -days 365 -extensions v3_ocsp -extfile ${OUTPUT_DIR}/ocsp.ext`);
    console.log('OCSP responder certificate created');
    
    // Step 4: Generate server certificate for Harper
    console.log('\nGenerating server certificate...');
    const serverKeyPath = path.join(OUTPUT_DIR, 'server.key');
    const serverCertPath = path.join(OUTPUT_DIR, 'server.crt');
    
    execSync(`openssl genrsa -out ${serverKeyPath} 2048`);
    
    // Server extensions with OCSP URL and CA issuer URL
    const serverExt = `[v3_server]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
authorityInfoAccess = OCSP;URI:http://localhost:${OCSP_PORT},caIssuers;URI:http://localhost:${OCSP_PORT}/ca.crt`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'server.ext'), serverExt);
    
    execSync(`openssl req -new -key ${serverKeyPath} -out ${OUTPUT_DIR}/server.csr -subj "/CN=localhost/O=Harper OCSP Test"`);
    execSync(`openssl x509 -req -in ${OUTPUT_DIR}/server.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${serverCertPath} -days 365 -extensions v3_server -extfile ${OUTPUT_DIR}/server.ext`);
    console.log('Server certificate created');
    
    // Step 5: Generate client certificates with OCSP URLs
    const clients = [
      { name: 'client-valid', cn: 'Valid Test Client' },
      { name: 'client-revoked', cn: 'Revoked Test Client' }
    ];
    
    for (const client of clients) {
      console.log(`\nGenerating ${client.name}...`);
      const keyPath = path.join(OUTPUT_DIR, `${client.name}.key`);
      const certPath = path.join(OUTPUT_DIR, `${client.name}.crt`);
      
      execSync(`openssl genrsa -out ${keyPath} 2048`);
      
      // Client extensions with OCSP URL and CA issuer URL
      const clientExt = `[v3_client]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
authorityInfoAccess = OCSP;URI:http://localhost:${OCSP_PORT},caIssuers;URI:http://localhost:${OCSP_PORT}/ca.crt`;
      fs.writeFileSync(path.join(OUTPUT_DIR, `${client.name}.ext`), clientExt);
      
      execSync(`openssl req -new -key ${keyPath} -out ${OUTPUT_DIR}/${client.name}.csr -subj "/CN=${client.cn}/O=Harper OCSP Test"`);
      execSync(`openssl x509 -req -in ${OUTPUT_DIR}/${client.name}.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${certPath} -days 365 -extensions v3_client -extfile ${OUTPUT_DIR}/${client.name}.ext`);
      
      console.log(`${client.name} created`);
    }
    
    // Step 5: Create certificate chains
    console.log('\nCreating certificate chains...');
    for (const client of clients) {
      const certPath = path.join(OUTPUT_DIR, `${client.name}.crt`);
      const chainPath = path.join(OUTPUT_DIR, `${client.name}-chain.crt`);
      const certContent = fs.readFileSync(certPath, 'utf8');
      const caContent = fs.readFileSync(caCertPath, 'utf8');
      fs.writeFileSync(chainPath, certContent + caContent);
      console.log(`Created ${client.name}-chain.crt`);
    }
    
    // Also create OCSP chain
    const ocspChainPath = path.join(OUTPUT_DIR, 'ocsp-chain.crt');
    const ocspContent = fs.readFileSync(ocspCertPath, 'utf8');
    fs.writeFileSync(ocspChainPath, ocspContent + fs.readFileSync(caCertPath, 'utf8'));
    console.log('Created ocsp-chain.crt');
    
    // Step 6: Create OCSP database
    console.log('\nCreating OCSP database...');
    const indexPath = path.join(OUTPUT_DIR, 'index.txt');
    const serialPath = path.join(OUTPUT_DIR, 'serial');
    
    fs.writeFileSync(indexPath, '');
    fs.writeFileSync(serialPath, '01\n');
    
    // Add certificate entries to index
    const { X509Certificate } = require('crypto');
    const validCert = new X509Certificate(fs.readFileSync(path.join(OUTPUT_DIR, 'client-valid.crt')));
    const revokedCert = new X509Certificate(fs.readFileSync(path.join(OUTPUT_DIR, 'client-revoked.crt')));
    
    // Format dates for OpenSSL index.txt (YYYYMMDDHHmmssZ format for validity, YYMMDDHHmmssZ for revocation)
    const now = new Date();
    const validFrom = now.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    const revocationDate = now.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
    
    // Format subject DN for OpenSSL index file (replace newlines with /)
    const validSubject = validCert.subject.replace(/\n/g, '/');
    const revokedSubject = revokedCert.subject.replace(/\n/g, '/');
    
    // Valid certificate entry (V status, empty revocation date)
    fs.appendFileSync(indexPath, `V\t${validFrom}\t\t${validCert.serialNumber}\tunknown\t${validSubject}\n`);
    
    // Revoked certificate entry (R status, includes revocation date)
    fs.appendFileSync(indexPath, `R\t${validFrom}\t${revocationDate}\t${revokedCert.serialNumber}\tunknown\t${revokedSubject}\n`);
    
    // Step 7: Display completion message
    
    console.log('\n=== Certificate Generation Complete! ===\n');
    console.log('Generated files in:', OUTPUT_DIR);
    console.log('- harper-ca.crt              : Harper\'s CA certificate');
    console.log('- server.crt/key             : Harper server certificate');
    console.log('- ocsp.crt/key               : OCSP responder certificate');
    console.log('- ocsp-chain.crt             : OCSP certificate chain');
    console.log('- client-valid.crt/key       : Valid client certificate');
    console.log('- client-valid-chain.crt     : Valid client certificate chain');
    console.log('- client-revoked.crt/key     : Revoked client certificate');
    console.log('- client-revoked-chain.crt   : Revoked client certificate chain');
    console.log('- index.txt                  : OCSP database\n');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the script
generateOCSPCerts().catch(console.error);