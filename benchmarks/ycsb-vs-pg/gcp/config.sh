# Settings shared by provision.sh, teardown.sh and run-estimate.sh. Each can be overridden from the
# environment. Sourced, not run.

YCSB_GCP_ZONE="${YCSB_GCP_ZONE:-us-central1-a}"
YCSB_GCP_REGION="${YCSB_GCP_ZONE%-*}"
# 4 physical cores with SMT off (--threads-per-core=1): the target gets every core of its VM. C4 is the
# series with a virtual PMU at this size, and one 375 GiB Titanium local SSD per -lssd VM.
YCSB_TARGET_MACHINE_TYPE="${YCSB_TARGET_MACHINE_TYPE:-c4-standard-8-lssd}"
YCSB_GEN_MACHINE_TYPE="${YCSB_GEN_MACHINE_TYPE:-c4-standard-16}"
YCSB_IMAGE_FAMILY="${YCSB_IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
YCSB_IMAGE_PROJECT="${YCSB_IMAGE_PROJECT:-ubuntu-os-cloud}"
# GCE deletes every VM of a run this long after it starts, whatever happens to the script that made it.
YCSB_MAX_RUN_DURATION="${YCSB_MAX_RUN_DURATION:-10h}"
YCSB_BOOT_DISK_SIZE="${YCSB_BOOT_DISK_SIZE:-50GB}"
YCSB_SUBNET_RANGE="${YCSB_SUBNET_RANGE:-10.77.0.0/24}"
YCSB_REPO_URL="${YCSB_REPO_URL:-https://github.com/HarperFast/harper.git}"
# CI's .node-version holds the major; the startup script installs its latest release.
YCSB_NODE_MAJOR="${YCSB_NODE_MAJOR:-26}"
# Documented limits of one Titanium SSD on a C4 VM (cloud.google.com/compute/docs/disks/local-ssd), for
# the run record: local SSD has no provisioned IOPS.
YCSB_DATA_DISK='{"type":"local-ssd (Titanium)","count":1,"sizeGiB":375,"provisionedIops":null,"documented":{"readIops":150000,"writeIops":75000,"readMiBps":625,"writeMiBps":330}}'

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
