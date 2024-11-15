#!/bin/bash
set -euo pipefail

# defaults
NPM_ACCESS="--access=restricted"
NPM_DRYRUN="true"
NPM_PACKAGE_NAME="@harperdb/harperdb"

# Unpack package tarball artifact from build job
tar -xf "harperdb-${HARPERDB_VERSION}.tgz"

[ "${DRYRUN}" == "false" ] && NPM_DRYRUN="${DRYRUN}"

# If publish_public is set to true, set access=public
if [[ "${PUBLISH_DESTINATION}" == "public" ]]
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
if [[ "${EXTRA_TAGS}" == "latest+stable" ]]
then
  NPM_TAG="stable"
  npm publish ./package/ "${NPM_ACCESS}" --dry-run="${NPM_DRYRUN}"
  if [[ "${DRYRUN}" == "true" ]]
  then
    echo "dry-run: npm dist-tag add ${NPM_PACKAGE_NAME}@${HARPERDB_VERSION} ${NPM_TAG}"
  else
    npm dist-tag add "${NPM_PACKAGE_NAME}@${HARPERDB_VERSION}" "${NPM_TAG}"
  fi
# else no extra tag
else
  NPM_TAG="${EXTRA_TAGS}"
  npm publish ./package/ --tag="${NPM_TAG}" "${NPM_ACCESS}" --dry-run="${NPM_DRYRUN}"
fi
