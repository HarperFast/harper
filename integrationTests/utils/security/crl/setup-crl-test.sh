#!/bin/bash

# Setup script for CRL testing
set -e

echo "Setting up CRL test environment..."

# Generate certificates and CRL
node generate-crl-certs.js

echo "CRL test environment setup complete."
echo ""
echo "Next steps:"
echo "1. Start the CRL server: node start-crl-server.js"
echo "2. In another terminal, run manual test: node test-crl-manual.js"
echo "3. Or run the full integration test suite"
