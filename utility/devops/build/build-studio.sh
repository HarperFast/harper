#!/bin/bash

PACKAGE_VERSION=$(sed -nr 's/^\s*\"version": "([0-9]{1,}\.[0-9]{1,}.*)",$/\1/p' package.json)
cat <<EOF > ./studio/src/config/index.js
export default {
  env: 'prod',
  lms_api_url: 'https://prod.harperdbcloudservices.com/',
  tc_version: '2020-01-01',
  check_version_interval: 300000,
  refresh_content_interval: 15000,
  free_cloud_instance_limit: 1,
  max_file_upload_size: 10380902,
  studio_version:'$PACKAGE_VERSION',
  alarm_badge_threshold: 86400,
  maintenance: 0,
  errortest: 0,
  is_local_studio: true,
};
EOF

cd studio
npm install -g pnpm
pnpm
pnpm run build:local
cd ..