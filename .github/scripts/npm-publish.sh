#!/bin/bash
set -euo pipefail

# defaults
NPM_ACCESS="--access=restricted"
NPM_DRYRUN="--dry-run"
NPM_TAG="next"
NPM_PACKAGE_NAME="@harperdb/harperdb"

# Unpack package tarball artifact from build job
tar -xf "harperdb-${HARPERDB_VERSION}.tgz"

# If dryrun is set to false, remove tag
if [[ "${DRYRUN}" == "false" ]]
then
  NPM_DRYRUN=""
fi

# If publish_public is set to true, set access=public
if [[ "${PUBLISH_PUBLIC}" == "true" ]]
then
  NPM_PACKAGE_NAME="harperdb"
  NPM_ACCESS="--access=public"
else
  # On line 2 of package.json, change the package name to @harperdb/harperdb
  sed -i '2 s/harperdb/@harperdb\/harperdb/' ./package/package.json
fi

echo "name in package.json:    $(jq -r '.name' ./package/package.json)"
echo "version in package.json: $(jq -r '.version' ./package/package.json)"

# also tag latest with 'stable'
if [[ "${TAG_LATEST}" == "true" ]]
then
  NPM_TAG="stable"
  npm publish ./package/ "${NPM_ACCESS}" "${NPM_DRYRUN}"
  if [[ "${DRYRUN}" == "true" ]]
  then
    echo "dry-run: npm dist-tag add ${NPM_PACKAGE_NAME}@${HARPERDB_VERSION} ${NPM_TAG}"
  else
    npm dist-tag add "${NPM_PACKAGE_NAME}@${HARPERDB_VERSION}" "${NPM_TAG}"
  fi
# else no extra tag
else
  npm publish ./package/ --tag="${NPM_TAG}" "${NPM_ACCESS}" "${NPM_DRYRUN}"
fi
