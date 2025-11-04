#!/bin/bash

# Prompt for password upfront
sudo -v

# Use environment variable or default to 32
COUNT=${HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT:-32}

# Validate COUNT is a number between 1 and 255
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "Error: HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT must be a number (got: $COUNT)"
  exit 1
fi

if [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 255 ]; then
  echo "Error: HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT must be between 1 and 255 (got: $COUNT)"
  exit 1
fi

for i in $(seq 1 $COUNT); do
  sudo ifconfig lo0 alias 127.0.0.$i up
done

echo "✓ Configured $COUNT loopback addresses (127.0.0.1-127.0.0.$COUNT)"