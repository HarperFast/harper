# Settings shared by provision.sh, teardown.sh and run-estimate.sh. Each can be overridden from the
# environment. Sourced, not run.

YCSB_GCP_ZONE="${YCSB_GCP_ZONE:-us-central1-a}"
YCSB_GCP_REGION="${YCSB_GCP_ZONE%-*}"
# The data volume of every target-shaped VM in a run: local-ssd (one 375 GiB Titanium SSD, the -lssd shape) or
# hyperdisk (one Hyperdisk Balanced volume with fixed provisioned IOPS and throughput, on the plain shape), for
# when the -lssd shape is out of capacity. The kind is recorded with the run.
YCSB_DATA_DISK_KIND="${YCSB_DATA_DISK_KIND:-local-ssd}"
YCSB_HYPERDISK_GB="${YCSB_HYPERDISK_GB:-375}"
# A c4-*-8's steady-state Hyperdisk Balanced limit (it bursts to 50,000 and 800): no burst credit varies results.
YCSB_HYPERDISK_IOPS="${YCSB_HYPERDISK_IOPS:-25000}"
YCSB_HYPERDISK_MIBPS="${YCSB_HYPERDISK_MIBPS:-480}"
case "$YCSB_DATA_DISK_KIND" in
local-ssd)
	YCSB_DATA_DEVICE=google-local-nvme-ssd-0
	# Documented limits of one Titanium SSD on a C4 VM (cloud.google.com/compute/docs/disks/local-ssd).
	YCSB_DATA_DISK='{"type":"local-ssd (Titanium)","count":1,"sizeGiB":375,"provisionedIops":null,"documented":{"readIops":150000,"writeIops":75000,"readMiBps":625,"writeMiBps":330}}'
	;;
hyperdisk)
	YCSB_DATA_DEVICE=google-ycsb-data
	YCSB_DATA_DISK="{\"type\":\"hyperdisk-balanced\",\"count\":1,\"sizeGiB\":$YCSB_HYPERDISK_GB,\"provisionedIops\":$YCSB_HYPERDISK_IOPS,\"provisionedThroughputMiBps\":$YCSB_HYPERDISK_MIBPS}"
	;;
*)
	echo "YCSB_DATA_DISK_KIND must be local-ssd or hyperdisk: $YCSB_DATA_DISK_KIND" >&2
	return 1
	;;
esac
# 4 physical cores with SMT off (--threads-per-core=1): the target gets every core of its VM. C4 is the
# series with a virtual PMU at this size.
if [ "$YCSB_DATA_DISK_KIND" = local-ssd ]; then
	YCSB_TARGET_MACHINE_TYPE="${YCSB_TARGET_MACHINE_TYPE:-c4-standard-8-lssd}"
else
	YCSB_TARGET_MACHINE_TYPE="${YCSB_TARGET_MACHINE_TYPE:-c4-standard-8}"
fi
# The Node driver spent 70-100 us of CPU per op on the XPS (README, "Load generator"), so a 4-core target serving
# 60-80k ops/s needs up to ~8 of the generator's cores; run-estimate.sh checks it is not the ceiling first.
YCSB_GEN_MACHINE_TYPE="${YCSB_GEN_MACHINE_TYPE:-c4-standard-32}"
YCSB_IMAGE_FAMILY="${YCSB_IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
YCSB_IMAGE_PROJECT="${YCSB_IMAGE_PROJECT:-ubuntu-os-cloud}"
# GCE deletes every VM of a run this long after it starts, whatever happens to the script that made it.
YCSB_MAX_RUN_DURATION="${YCSB_MAX_RUN_DURATION:-12h}"
YCSB_BOOT_DISK_SIZE="${YCSB_BOOT_DISK_SIZE:-50GB}"
YCSB_SUBNET_RANGE="${YCSB_SUBNET_RANGE:-10.77.0.0/24}"
YCSB_REPO_URL="${YCSB_REPO_URL:-https://github.com/HarperFast/harper.git}"
# CI's .node-version holds the major; the startup script installs its latest release.
YCSB_NODE_MAJOR="${YCSB_NODE_MAJOR:-26}"

YCSB_GCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YCSB_RUNS_DIR="${YCSB_RUNS_DIR:-$YCSB_GCP_DIR/runs}"
# On every VM: the checkout, and (generator) the hosts file and the per-run key.
YCSB_VM_REPO=/opt/ycsb/harper
YCSB_VM_USER=ycsb

# A run id names every resource of the run and labels its VMs.
ycsb_check_run_id() {
	case "$1" in
	ycsb-[a-z0-9]*) ;;
	*)
		echo "run id must start with ycsb- and use lowercase letters, digits and -: $1" >&2
		return 1
		;;
	esac
	if [ "${#1}" -gt 40 ] || ! printf '%s' "$1" | grep -Eq '^[a-z][a-z0-9-]*[a-z0-9]$'; then
		echo "run id must be at most 40 lowercase letters, digits and -: $1" >&2
		return 1
	fi
}

# The roles of a topology set: a = generator, harper, stack; ab adds the redis and postgres VMs of (b).
ycsb_roles() {
	case "$1" in
	a) echo "generator harper stack" ;;
	ab) echo "generator harper stack redis postgres" ;;
	*)
		echo "topology must be a or ab: $1" >&2
		return 1
		;;
	esac
}

# Runs gcloud, or with YCSB_DRY_RUN=1 prints the command instead (one line, "+ gcloud ...").
gc() {
	if [ "${YCSB_DRY_RUN:-0}" = 1 ]; then
		printf '+ gcloud'
		printf ' %s' "$@"
		printf '\n'
		return 0
	fi
	gcloud --quiet "$@"
}
