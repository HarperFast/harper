#!/usr/bin/env bash
# The short estimate: does running Redis and Postgres on their own VMs (topology b) change the stack's
# numbers enough to put b in the full matrix? Provisions a run (both topologies), checks the generator
# is not the ceiling, runs a smoke pass, then harper-uws, pg-redis and pg-redis@b on C, inspect and
# chain-4, warm and 2x, token auth, 3 reps. Results are copied back after every phase; teardown runs on
# exit whatever happened, after one last copy.
#
#   YCSB_GCP_PROJECT=<project> YCSB_GCP_ZONE=<zone> gcp/run-estimate.sh [--run-id=<id>] [--commit=<sha>]
set -euo pipefail
. "$(dirname "$0")/config.sh"
: "${YCSB_GCP_PROJECT:?set YCSB_GCP_PROJECT}"
RUN_ID=""
PASS=()
for arg in "$@"; do
	case "$arg" in
	--run-id=*) RUN_ID="${arg#*=}" ;;
	--commit=*) PASS+=("$arg") ;;
	*)
		echo "unknown argument $arg" >&2
		exit 2
		;;
	esac
done
[ -n "$RUN_ID" ] || RUN_ID="ycsb-$(date -u +%Y%m%d-%H%M)-est"
ycsb_check_run_id "$RUN_ID"
RUN_DIR="$YCSB_RUNS_DIR/$RUN_ID"
KEY="$RUN_DIR/id_ed25519"
P=(--project="$YCSB_GCP_PROJECT" --zone="$YCSB_GCP_ZONE")
REMOTE_RESULTS="$YCSB_VM_REPO/benchmarks/ycsb-vs-pg/results"
TARGETS=harper-uws,pg-redis,pg-redis@b
WORKLOADS=C,inspect,chain-4
COMMON="--hosts=/opt/ycsb/hosts.json --targets=$TARGETS --auth=token"

on_gen() { gcloud compute ssh "$YCSB_VM_USER@$RUN_ID-generator" "${P[@]}" --ssh-key-file="$KEY" --command="$1"; }
collect() {
	mkdir -p "$RUN_DIR/results"
	timeout 600 gcloud compute scp --recurse "${P[@]}" --ssh-key-file="$KEY" \
		"$YCSB_VM_USER@$RUN_ID-generator:$REMOTE_RESULTS/*" "$YCSB_VM_USER@$RUN_ID-generator:/opt/ycsb/logs" \
		"$RUN_DIR/results/" || echo "copying results from the generator failed" >&2
}
finish() {
	status=$?
	collect
	"$YCSB_GCP_DIR/teardown.sh" "$RUN_ID" || status=1
	exit "$status"
}

"$YCSB_GCP_DIR/provision.sh" --run-id="$RUN_ID" --topology=ab "${PASS[@]}"
trap finish EXIT

# A phase runs on the generator as a user service, so a dropped ssh session does not end it; this
# waits for it and fails with it.
phase() {
	local name=$1 command=$2
	echo "=== phase $name"
	on_gen "systemd-run --user --unit=ycsb-$name --property=StandardOutput=file:/opt/ycsb/logs/$name.log \
		--property=StandardError=file:/opt/ycsb/logs/$name.log --working-directory=$YCSB_VM_REPO \
		/bin/bash -c $(printf '%q' "$command")"
	while :; do
		sleep 60
		state=$(on_gen "systemctl --user show -P ActiveState ycsb-$name; tail -n 2 /opt/ycsb/logs/$name.log >&2" || echo unknown)
		case "$state" in
		active | activating | reloading | deactivating | unknown) ;;
		*) break ;;
		esac
	done
	result=$(on_gen "systemctl --user show -P Result ycsb-$name")
	collect
	[ "$result" = success ] || {
		echo "phase $name: $result (log in $RUN_DIR/results/logs/$name.log)" >&2
		return 1
	}
}

HARPER_IP=$(jq -r '.roles.harper.address' "$RUN_DIR/hosts.json")
# The generator's own ceiling over the VPC: a fixed record served from the harper VM's 4 cores.
gcloud compute ssh "$YCSB_VM_USER@$RUN_ID-harper" "${P[@]}" --ssh-key-file="$KEY" --command="cd $YCSB_VM_REPO && \
	systemd-run --user --unit=ycsb-ceiling-server node benchmarks/ycsb-vs-pg/client-ceiling.mts --serve=4 --host=$HARPER_IP"
sleep 10
phase ceiling "node benchmarks/ycsb-vs-pg/client-ceiling.mts --base-url=http://$HARPER_IP:9941 --concurrency=64"
gcloud compute ssh "$YCSB_VM_USER@$RUN_ID-harper" "${P[@]}" --ssh-key-file="$KEY" --command='systemctl --user stop ycsb-ceiling-server'

# Every code path once, at a size that takes minutes: both topologies, dependent reads, a write, a snapshot.
phase smoke-compare "node benchmarks/ycsb-vs-pg/run-compare.mts $COMMON --scale=quick --workloads=C,B,chain-4 --reps=1"
phase smoke-sweep "node benchmarks/ycsb-vs-pg/memory-sweep.mts $COMMON --ratios=0.002 --workloads=C,inspect --reps=1 \
	--warmup-chunk=20000 --warmup-max-chunks=3 --ops=20000"

phase warm "node benchmarks/ycsb-vs-pg/run-compare.mts $COMMON --workloads=$WORKLOADS --reps=3 --host-quiet-cores=1"
phase sweep-2x "node benchmarks/ycsb-vs-pg/memory-sweep.mts $COMMON --ratios=2 --workloads=$WORKLOADS --reps=3"
echo "estimate done: $RUN_DIR/results"
