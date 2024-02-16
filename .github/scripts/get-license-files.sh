#!/usr/bin/env bash

set -eou pipefail

LICENSES_DIR="${LICENSES_DIR:-utility/Docker/licenses}"

dependencies=(curl pandoc jq)

# check for missing dependencies
missing_packages=""
for dependency in ${dependencies[@]}; do
  if ! command -v ${dependency} &> /dev/null; then
    missing_packages="${dependency} ${missing_packages}"
  fi
done

# attempt to install dependencies if we are in debian/ubuntu
if command -v apt-get &> /dev/null; then
  echo "installing ${missing_packages}"
  sudo apt-get -qq update
  sudo apt-get -qq -y install ${missing_packages}
fi

# verify dependencies
for package in ${missing_packages[@]}; do
  if ! command -v ${package} &> /dev/null
  then
      echo "required command ${package} could not be found"
      exit 1
  fi
done

# make sure directory exists
[[ -d "${LICENSES_DIR}" ]] || mkdir -p ${LICENSES_DIR}

echo "Using ${LICENSES_DIR}"

# add the LICENSE file from this repo
echo "copying LICENSE as end-user-license-agreement.md"
cp LICENSE ${LICENSES_DIR}/end-user-license-agreement.md

# the following can be scraped from our website
docs=(
  terms-of-use
#  open-source-licenses-notices < now created in gha
)

for doc in ${docs[@]}; do
  echo "downloading ${doc} as ${doc}.md"
  curl \
  -sL \
  "https://www.harperdb.io/legal/${doc}" \
  | sed -rn 's@(^.*)(<div class="section-21 wf-section">.*)@\2@p' \
  | sed -rn 's@(^.*)(<div class="footer wf-section">.*)@\1@p' \
  | pandoc \
    -f html \
    -t commonmark-raw_html \
    --wrap none \
  > ${LICENSES_DIR}/${doc}.md
done

# pull the privacy policy directly from iubenda.com
# privacy policy
echo "downloading privacy-policy as privacy-policy.md"
curl \
  -sL \
  "https://www.iubenda.com/api/privacy-policy/56029547/no-markup" \
  | jq -r '.content' \
  | pandoc \
    -f html \
    -t commonmark-raw_html \
    --wrap none \
  > ${LICENSES_DIR}/privacy-policy.md

# process pdf files now
# on-prem-license-agreement
echo "downloading pdf on-prem-license-agreement v10 from 2021-05-12 as on-prem-license-agreement-v10-2021-05-12.pdf"
curl \
  -sL \
  "https://f.hubspotusercontent20.net/hubfs/2940328/HarperDB%20-%20Form%20On-Prem%20Software%20License%20Agreement%20v10%202021-05-12%20(Clean)%20(1).pdf" \
  -o ${LICENSES_DIR}/on-prem-license-agreement-v10-2021-05-12.pdf
