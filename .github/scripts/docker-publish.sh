$!/usr/bin/env bash

set -euo pipefail

# default to "utility/Docker/Dockerfile" if not defined
docker_file="${DOCKERFILE:=utility/Docker/Dockerfile}"

# default to mainline "harperdb/harperdb" image if not defined
docker_image="${DOCKER_IMAGE:=harperdb/harperdb}"

docker_tag="${HARPERDB_VERSION}"

# add the GITHUB_RUN_NUMBER if we are publishing to the private repo.
# this value does not change if you re-run the workflow.
if [[ "${PUBLISH}" == "private" ]]; then
  docker_tag="${docker_tag}-${GITHUB_RUN_NUMBER:-1}"
  docker_image="harperdb/private"
fi

docker_platform="linux/amd64,linux/arm64"
docker_output="type=registry"

# docker type output can only support a single arch.
if [[ "${PUBLISH}" == "tar" ]]; then
  docker_platform="linux/amd64"
  docker_output="type=docker,dest=docker-harperdb_${docker_tag}.tar"
fi

docker buildx build \
  --file ${DOCKERFILE} \
  --build-arg NODE_VERSION=${NODE_VERSION} \
  --build-arg HARPERDB_VERSION=${HARPERDB_VERSION} \
  --build-arg HARPERDB_TARBALL=harperdb-${HARPERDB_VERSION}.tgz \
  --build-arg VCS_REF=`git rev-parse HEAD` \
  --build-arg BUILD_DATE=`date -u +%FT%T` \
  --platform ${docker_platform} \
  --no-cache \
  --output ${docker_output} \
  --tag ${docker_image}:latest \
  --tag ${docker_image}:${docker_tag} .