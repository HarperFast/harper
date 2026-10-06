#!/usr/bin/env bash
# Start a Harper container and wait for its Operations API to answer on :9925.
#
# Usage: docker-smoke-boot.sh <image> <container-name> [harper-runtime]
set -e

image=$1
container=$2
runtime=$3

runtimeEnv=()
if [ -n "$runtime" ]; then
	runtimeEnv=(-e "HARPER_RUNTIME=$runtime")
fi

docker run -d --name "$container" \
	"${runtimeEnv[@]}" \
	-e HDB_ADMIN_USERNAME=admin \
	-e HDB_ADMIN_PASSWORD=password \
	-p 9925:9925 \
	"$image"

echo "Waiting for Operations API on :9925 (${runtime:-default} runtime) ..."
for _ in $(seq 1 60); do
	code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://localhost:9925/ || true)
	# Any HTTP response (even 401/404) means the server is up and listening.
	if [ -n "$code" ] && [ "$code" != "000" ]; then
		echo "Operations API responded with HTTP $code after ${SECONDS}s"
		exit 0
	fi
	if ! docker ps --filter "name=$container" --filter status=running -q | grep -q .; then
		echo "::error::Container exited before the Operations API came up"
		docker logs "$container"
		exit 1
	fi
	sleep 1
done

echo "::error::Operations API did not come up within ${SECONDS}s"
docker logs "$container"
exit 1
