#!/usr/bin/env node

/**
 * Generate test certificates for CRL integration testing
 * This script generates a complete test CA and certificates for CRL testing
 * Similar to the OCSP test certificate generation but with CRL distribution points
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { getHarperCA } = require('../harperCA.js');

// Function to find Harper keys directory in common locations
function findHarperKeysDir() {
  const { homedir } = require('os');
  const possiblePaths = [
    // Local development path
    path.join(homedir(), 'hdb', 'keys'),
    // CI or different installation paths
    path.join(homedir(), '.harperdb', 'keys'),
    path.join(process.cwd(), '..', '..', '..', '..', 'keys'),
    path.join('/tmp', 'harperdb', 'keys'),
    path.join('/var', 'harperdb', 'keys'),
    // Check HARPERDB_ROOT env var if set
    ...(process.env.HARPERDB_ROOT ? [path.join(process.env.HARPERDB_ROOT, 'keys')] : [])
  ];

  for (const keyPath of possiblePaths) {
    if (fs.existsSync(keyPath)) {
      console.log(`Found Harper keys directory at: ${keyPath}`);
      return keyPath;
    }
  }

  return null;
}

const OUTPUT_DIR = path.join(__dirname, 'generated');
const CRL_PORT = process.env.CRL_PORT || 8889;
const CRL_HOST = process.env.CRL_HOST || 'localhost';

function generateClientCerts(caKeyPath, caCertPath) {
  console.log('\nGenerating client certificates...');

  // Generate valid client certificate
  const validKeyPath = path.join(OUTPUT_DIR, 'client-valid.key');
  const validCsrPath = path.join(OUTPUT_DIR, 'client-valid.csr');
  const validCertPath = path.join(OUTPUT_DIR, 'client-valid.crt');
  const validChainPath = path.join(OUTPUT_DIR, 'client-valid-chain.crt');

  execSync(`openssl genpkey -algorithm ED25519 -out ${validKeyPath}`);
  execSync(`openssl req -new -key ${validKeyPath} -out ${validCsrPath} -subj "/CN=Valid CRL Client/O=Harper CRL Test"`);

  // Create extensions for valid client cert with CRL distribution point
  const validExtensions = `[v3_client]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
crlDistributionPoints = URI:http://${CRL_HOST}:${CRL_PORT}/test.crl`;

  const validExtFile = path.join(OUTPUT_DIR, 'client-valid.ext');
  fs.writeFileSync(validExtFile, validExtensions);

  execSync(`openssl x509 -req -in ${validCsrPath} -CA ${caCertPath} -CAkey ${caKeyPath} -out ${validCertPath} -days 30 -extensions v3_client -extfile ${validExtFile} -CAcreateserial`);

  // Create certificate chain (client cert + CA)
  const validCertContent = fs.readFileSync(validCertPath, 'utf8');
  const caCertContent = fs.readFileSync(caCertPath, 'utf8');
  fs.writeFileSync(validChainPath, validCertContent + caCertContent);

  // Generate revoked client certificate
  const revokedKeyPath = path.join(OUTPUT_DIR, 'client-revoked.key');
  const revokedCsrPath = path.join(OUTPUT_DIR, 'client-revoked.csr');
  const revokedCertPath = path.join(OUTPUT_DIR, 'client-revoked.crt');
  const revokedChainPath = path.join(OUTPUT_DIR, 'client-revoked-chain.crt');

  execSync(`openssl genpkey -algorithm ED25519 -out ${revokedKeyPath}`);
  execSync(`openssl req -new -key ${revokedKeyPath} -out ${revokedCsrPath} -subj "/CN=Revoked CRL Client/O=Harper CRL Test"`);

  // Create extensions for revoked client cert with CRL distribution point
  const revokedExtensions = `[v3_client]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
crlDistributionPoints = URI:http://${CRL_HOST}:${CRL_PORT}/test.crl`;

  const revokedExtFile = path.join(OUTPUT_DIR, 'client-revoked.ext');
  fs.writeFileSync(revokedExtFile, revokedExtensions);

  execSync(`openssl x509 -req -in ${revokedCsrPath} -CA ${caCertPath} -CAkey ${caKeyPath} -out ${revokedCertPath} -days 30 -extensions v3_client -extfile ${revokedExtFile} -CAcreateserial`);

  // Create certificate chain (client cert + CA)
  const revokedCertContent = fs.readFileSync(revokedCertPath, 'utf8');
  fs.writeFileSync(revokedChainPath, revokedCertContent + caCertContent);

  console.log('Client certificates generated successfully');

  return {
    valid: { keyPath: validKeyPath, certPath: validCertPath, chainPath: validChainPath },
    revoked: { keyPath: revokedKeyPath, certPath: revokedCertPath, chainPath: revokedChainPath }
  };
}

function generateCRL(caKeyPath, caCertPath, revokedCertPath) {
  console.log('\nGenerating CRL...');

  // Create index.txt file for CRL generation
  const indexPath = path.join(OUTPUT_DIR, 'index.txt');
  const serialPath = path.join(OUTPUT_DIR, 'crlnumber');
  const crlPath = path.join(OUTPUT_DIR, 'test.crl');

  // Initialize files
  fs.writeFileSync(indexPath, '');
  fs.writeFileSync(serialPath, '01\n');

  // Get serial number of revoked certificate
  const revokedSerial = execSync(`openssl x509 -in ${revokedCertPath} -noout -serial`).toString().trim().replace('serial=', '');

  // Format date for OpenSSL index.txt (YYMMDDHHMMSSZ format)
  const now = new Date();
  const revocationDate = now.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  const expiryDate = new Date(Date.now() + 30*24*60*60*1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';

  // Add revoked certificate to index.txt (OpenSSL format: Status<TAB>ExpiryDate<TAB>RevocationDate<TAB>SerialNumber<TAB>FileName<TAB>DistinguishedName)
  const revokedEntry = `R\t${expiryDate}\t${revocationDate}\t${revokedSerial}\tunknown\t/CN=Revoked CRL Client/O=Harper CRL Test\n`;
  fs.writeFileSync(indexPath, revokedEntry);

  // Create minimal openssl config for CRL generation
  const configContent = `
[ca]
default_ca = test_ca

[test_ca]
dir = ${OUTPUT_DIR}
database = ${indexPath}
crlnumber = ${serialPath}
certificate = ${caCertPath}
private_key = ${caKeyPath}
default_md = sha256
default_crl_days = 30
crl = ${OUTPUT_DIR}/test.crl
`;

  const configPath = path.join(OUTPUT_DIR, 'openssl.conf');
  fs.writeFileSync(configPath, configContent);

  // Generate CRL
  execSync(`openssl ca -config ${configPath} -gencrl -out ${crlPath}`);

  console.log('CRL generated successfully');
  return crlPath;
}

async function generateCRLCerts() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  try {
    console.log('Generating CRL test certificates...');

    // Step 1: Get Harper's CA
    const ca = await getHarperCA();

    // Save CA certificate for convenience
    const caCertPath = path.join(OUTPUT_DIR, 'harper-ca.crt');
    fs.writeFileSync(caCertPath, ca.certificate);
    console.log(`CA certificate saved to: ${caCertPath}`);

    // Step 2: Find CA private key
    const harperKeysDir = findHarperKeysDir();
    if (!harperKeysDir) {
      console.error('\nERROR: Harper keys directory not found');
      console.error('Tried the following locations:');
      console.error('- ~/hdb/keys');
      console.error('- ~/.harperdb/keys');
      console.error('- /tmp/harperdb/keys');
      console.error('- /var/harperdb/keys');
      if (process.env.HARPERDB_ROOT) {
        console.error(`- ${process.env.HARPERDB_ROOT}/keys`);
      }
      throw new Error('Harper keys directory not found');
    }

    const caKeyPath = path.join(harperKeysDir, ca.private_key_name);
    if (!fs.existsSync(caKeyPath)) {
      console.error(`\nERROR: CA private key not found at: ${caKeyPath}`);
      console.error('Please check the path to Harper\'s keys directory');
      console.error(`Expected Harper keys directory: ${harperKeysDir}`);
      return;
    }

    console.log(`Using CA private key from: ${caKeyPath}`);

    // Generate client certificates
    const clientCerts = generateClientCerts(caKeyPath, caCertPath);

    // Generate CRL with revoked certificate
    generateCRL(caKeyPath, caCertPath, clientCerts.revoked.certPath);

    console.log('\n✅ All CRL test certificates generated successfully!');
    console.log('Generated files:');
    console.log('  - harper-ca.crt (Harper\'s CA certificate)');
    console.log('  - client-valid-chain.crt (Valid client certificate chain)');
    console.log('  - client-revoked-chain.crt (Revoked client certificate chain)');
    console.log('  - test.crl (Certificate Revocation List)');

  } catch (error) {
    console.error('Error generating CRL certificates:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  generateCRLCerts();
}

module.exports = { generateCRLCerts };