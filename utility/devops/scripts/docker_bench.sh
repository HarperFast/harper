#!/usr/bin/env bash
set -euo pipefail

############################################################
# help                                                     #
############################################################
help() {
  # Display help
  echo "Gather system metrics with sar around launching a set of docker containers"
  echo "  This script replies on docker, sar (found in the sysstat package in Linux only), and parallel"
  echo
  echo "to view metrics, run 'docker run -dp 3000:3000 odidev/sarchart' locally and upload the generated txt file"
  echo
  echo "Syntax: docker-bench.sh [-h] [options ...]"
  echo "options:"
  echo "f     Filename prefix to save metrics. file will be saved as both 'sar' and 'txt'"
  echo "      If the filename contains a path, you should make sure it exists first."
  echo "      default: $(date +%Y%m%d-%H%M%S)-docker"
  echo "c     Command to run container with. Should be generally compatible with docker. ex: podman."
  echo "      default: docker"
  echo "i     Docker image to use. You can use this to overload the command as well."
  echo "      default: harperdb/harperdb"
  echo "e     Extra args to pass into docker (or whichever command ex: '--runtime=/usr/bin/crun'"
  echo "      default: ''" 
  echo "r     How many replicas of the container you want. Uses parallel to launch"
  echo "      default: 10"
  echo "s     Seconds to gather metrics."
  echo "      default: 20"
  echo "v     verbose"
  echo "h     Print this Help."
  echo
}


# try to verify that we are on GNU/Linux
if [ "$(uname --operating-system)" != "GNU/Linux" ]; then
  echo "This script requires the 'sar' executable from the 'sysstat' package, which is a linux specific tool for gathering system metrics."
  echo "It appears that we are on $(uname --operating-system)"
  exit 1
fi

# set some defaults
file_prefix="$(date +%Y%m%d-%H%M%S)"
docker_cmd="docker"
docker_image="harperdb/harperdb"
docker_extra_args=""
replicas=10
settle=20 
DEBUG=""

# used in creation of containers
uuid=$(uuidgen -t)

# parse options for overrides
while getopts "f:c:i:e:r:s:hv" option; do
  case $option in
    f) file_prefix="${OPTARG}";;
    c) docker_cmd="${OPTARG}";;
    i) docker_image="${OPTARG}";;
    e) docker_extra_args="${OPTARG}";;
    r) replicas=${OPTARG};;
    s) settle=${OPTARG};;
    v) DEBUG=1;;
    h|*) help
       exit;;
  esac
done

# set base name for output files
file="${file_prefix}-${docker_cmd}"

# function to stop sar, clean up containers and finalize output
function cleanup() {
  [ -n "${DEBUG}" ] && echo "#########################"
  [ -n "${DEBUG}" ] && echo "# cleaning up processes"
  [ -n "${DEBUG}" ] && echo "#########################"

  # kill background process
  kill %1 2>/dev/null || true

  # stop containers
  seq -w 1 "${replicas}" |\
    parallel "${docker_cmd} stop docker-bench-${uuid}-{#}" >/dev/null 1>&1

  # finalize output
  sar -A -f "${file}.sar" > "${file}.txt"
}

# if we get interrupted (or just finish naturally, this ensures that the cleanup function is called
trap cleanup EXIT

# throw some values out if the '-v' flag was specified
if  [ -n "${DEBUG}" ]; then
  echo "file:              ${file}"
  echo "docker_cmd:        ${docker_cmd}"
  echo "docker_image:      ${docker_image}"
  echo "docker_extra_args: ${docker_extra_args}"
  echo "replicas:          ${replicas}"
  echo "settle:            ${settle}"
fi

[ -n "${DEBUG}" ] && echo "##################################################"
[ -n "${DEBUG}" ] && echo "# pulling ${docker_image} for test"
[ -n "${DEBUG}" ] && echo "##################################################"

${docker_cmd} pull "${docker_image}"

[ -n "${DEBUG}" ] && echo "recording metrics in ${file}.sar"
sar -A -o "${file}.sar" 1 >/dev/null 2>&1 &

seq -w 1 "${replicas}" |\
  parallel --bar \
    "${docker_cmd} \
      run \
      ${docker_extra_args} \
      --name docker-bench-${uuid}-{#} \
      -d ${docker_image}"

[ -n "${DEBUG}" ] && echo "##################################################"
[ -n "${DEBUG}" ] && echo "# containers launched, gathering metrics for the next ${settle} seconds"
[ -n "${DEBUG}" ] && echo "##################################################"

for i in $(seq "${settle}" -1 1); do echo -ne "\r${i} "; sleep 1; done
echo -ne "\r"


[ -n "${DEBUG}" ] && echo "#########################"
[ -n "${DEBUG}" ] && echo "# testing complete"
[ -n "${DEBUG}" ] && echo "#########################"
[ -n "${DEBUG}" ] && echo
[ -n "${DEBUG}" ] && echo "ran ${docker_cmd} ${docker_extra_args} ${docker_image}"
[ -n "${DEBUG}" ] && echo "collected metrics for ${settle} seconds"

echo "metrics stored in ${file}.sar"
echo "              and ${file}.txt"
echo "to view metrics, run 'docker run -dp 3000:3000 odidev/sarchart' locally and upload ${file}.txt"
