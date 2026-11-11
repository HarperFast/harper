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
[ -n "$RUN_ID" ] || RUN_ID="ycsb-$(date -u +%Y%m%d-%H%M)-est-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
ycsb_check_run_id "$RUN_ID"
RUN_DIR="$YCSB_RUNS_DIR/$RUN_ID"
KEY="$RUN_DIR/id_ed25519"
P=(--project="$YCSB_GCP_PROJECT" --zone="$YCSB_GCP_ZONE")
REMOTE_RESULTS="$YCSB_VM_REPO/benchmarks/ycsb-vs-pg/results"
TARGETS=harper-uws,pg-redis,pg-redis@b
WORKLOADS=C,inspect,chain-4
COMMON="--hosts=/opt/ycsb/hosts.json --targets=$TARGETS --auth=token"

on_gen() { gcloud compute ssh "$YCSB_VM_USER@$RUN_ID-generator" "${P[@]}" --ssh-key-file="$KEY" --command="$1"; }
# Fails, after three tries, if the results could not be copied: the generator holds the only copy.
# Copies both directories whole (into $RUN_DIR/results and $RUN_DIR/logs), so an empty one is not an error.
collect() {
	for try in 1 2 3; do
		timeout 600 gcloud compute scp --recurse "${P[@]}" --ssh-key-file="$KEY" \
			"$YCSB_VM_USER@$RUN_ID-generator:$REMOTE_RESULTS" "$YCSB_VM_USER@$RUN_ID-generator:/opt/ycsb/logs" \
			"$RUN_DIR/" && return 0
		echo "copying results from the generator failed (try $try)" >&2
		sleep 30
	done
	return 1
}
finish() {
	status=$?
	if ! collect; then
		echo "results since the last successful copy are lost: the generator is being deleted (cost guard)" >&2
		status=1
	fi
	"$YCSB_GCP_DIR/teardown.sh" "$RUN_ID" || status=1
	exit "$status"
}

"$YCSB_GCP_DIR/provision.sh" --run-id="$RUN_ID" --topology=ab "${PASS[@]}"
trap finish EXIT
on_gen "mkdir -p $REMOTE_RESULTS /opt/ycsb/logs"

# A phase runs on the generator as a user service, so a dropped ssh session does not end it. It writes
# its exit status to a file when it ends, which this polls; the generator unreachable for 15 polls in a
# row ends the wait. Results are copied every 10 minutes and at the end.
phase() {
	local name=$1 command=$2 status="" unreachable=0 polls=0
	echo "=== phase $name"
	on_gen "rm -f /opt/ycsb/logs/$name.status; systemd-run --user --unit=ycsb-$name \
		--property=StandardOutput=file:/opt/ycsb/logs/$name.log --property=StandardError=file:/opt/ycsb/logs/$name.log \
		--working-directory=$YCSB_VM_REPO /bin/bash -c $(printf '%q' "$command; echo \$? > /opt/ycsb/logs/$name.status.tmp && mv /opt/ycsb/logs/$name.status.tmp /opt/ycsb/logs/$name.status")"
	while [ -z "$status" ]; do
		sleep 60
		polls=$((polls + 1))
		# No status file and no running unit: systemd ended the phase before the wrapper could write one.
		if out=$(on_gen "s=/opt/ycsb/logs/$name.status; tail -n 2 /opt/ycsb/logs/$name.log >&2; if [ -s \$s ]; then cat \$s; \
			elif ! systemctl --user is-active -q ycsb-$name; then if [ -s \$s ]; then cat \$s; else echo ended-without-status; fi; fi"); then
			unreachable=0
			status=$out
		else
			unreachable=$((unreachable + 1))
			[ "$unreachable" -lt 15 ] || {
				echo "phase $name: the generator has been unreachable for 15 minutes" >&2
				return 1
			}
		fi
		[ $((polls % 10)) -ne 0 ] || collect || true
	done
	collect
	[ "$status" = 0 ] || {
		echo "phase $name exited $status (log in $RUN_DIR/logs/$name.log)" >&2
		return 1
	}
}

HARPER_IP=$(jq -r '.roles.harper.address' "$RUN_DIR/hosts.json")
# The generator's own ceiling over the VPC: a fixed record served from the harper VM's 4 cores.
gcloud compute ssh "$YCSB_VM_USER@$RUN_ID-harper" "${P[@]}" --ssh-key-file="$KEY" --command="systemd-run --user \
	--unit=ycsb-ceiling-server --working-directory=$YCSB_VM_REPO \
	/usr/local/bin/node benchmarks/ycsb-vs-pg/client-ceiling.mts --serve=4 --host=$HARPER_IP"
on_gen "for i in \$(seq 60); do curl -fsS -o /dev/null http://$HARPER_IP:9941/usertable/x && exit 0; sleep 1; done; exit 1"
# One shard per generator vCPU, and half that. The measured cells use whichever served more on C without the
# driver being the limit (over half its capacity busy); with neither, nothing is measured.
GEN_CPUS=$(on_gen nproc)
best="" best_ops=0
for shards in "$GEN_CPUS" $((GEN_CPUS / 2)); do
	phase "ceiling-$shards" "node benchmarks/ycsb-vs-pg/client-ceiling.mts --base-url=http://$HARPER_IP:9941 \
		--concurrency=64 --shards=$shards --max-generator-busy=0.5" || true
	log="$RUN_DIR/logs/ceiling-$shards.log"
	ops=$(sed -n 's/.*CLIENT_CEILING workload=C .*ops_per_sec=\([0-9]*\).*/\1/p' "$log" 2>/dev/null | tail -1)
	if [ -n "$ops" ] && ! grep -q CLIENT_CEILING_FAILED "$log" && [ "$ops" -gt "$best_ops" ]; then
		best=$shards best_ops=$ops
	fi
done
gcloud compute ssh "$YCSB_VM_USER@$RUN_ID-harper" "${P[@]}" --ssh-key-file="$KEY" --command='systemctl --user stop ycsb-ceiling-server'
[ -n "$best" ] || {
	echo "the generator was the limit at every shard count tried; raise YCSB_GEN_MACHINE_TYPE" >&2
	exit 1
}
echo "measured cells run with --shards=$best (client-ceiling: $best_ops ops/s on C)"
COMMON="$COMMON --shards=$best"

# Every code path once, at a size that takes minutes: both topologies, dependent reads, a write, a snapshot.
phase smoke-compare "node benchmarks/ycsb-vs-pg/run-compare.mts $COMMON --scale=quick --workloads=C,B,chain-4 --reps=1"
phase smoke-sweep "node benchmarks/ycsb-vs-pg/memory-sweep.mts $COMMON --ratios=0.002 --workloads=C,inspect --reps=1 \
	--warmup-chunk=20000 --warmup-max-chunks=3 --ops=20000"

phase warm "node benchmarks/ycsb-vs-pg/run-compare.mts $COMMON --workloads=$WORKLOADS --reps=3 --host-quiet-cores=1"
phase sweep-2x "node benchmarks/ycsb-vs-pg/memory-sweep.mts $COMMON --ratios=2 --workloads=$WORKLOADS --reps=3"
echo "estimate done: $RUN_DIR/results"
