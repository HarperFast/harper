#!/usr/bin/env bash

set -euo pipefail

## Info:
# this script is used to generate, format, then upload to webflow this page: https://www.harperdb.io/legal/open-source-licenses-notices
# API calls documentation: https://developers.webflow.com/reference/
#
## Usage:
# Here is a list of env variables that can be set:
#   TOKEN - webflow API access token. created by jake@harperdb.io
#   API - just the base URL for the webflow api
#   LICENSE_DIR - path (relative or absolute) to the directory with generated license files. Should be in markdown
#   MARKDOWN_LICENSE_FILE - name of temporary file containing all licenses in markdown format
#   WORK_DIR - where we create the content files to upload
#   PUBLISH - utilizes the 'live' flag in the PATCH call (last api call) to make either a draft or publish the changes
#   SITE_SHORT_NAME - an account specific unique identifier in webflow that identifies https://harperdb.io
#   COLLECTION_SLUG - an account specific unique identifier in webflow that identifies the legal collection of pages on https://harperdb.io
#   ITEM_SLUG - an account specific unique identifier in webflow that identifies the open source license and notifications page on https://harperdb.io
#   ITEM_NAME - this value represents the header for the page being updated
#   MAX_NUMBER_FILES - the number of files to create with csplit. probably shouldn't be messed with
#   LINES_PER_CONTENT_FIELD - how many lines that csplit will create per file. this is mostly a guess on how much content we can fit into each content field.

# fail if we don't set TOKEN
[[ -z "${TOKEN}" ]] && echo "TOKEN not set" && exit 1

# this is for the live flag in the PATCH api call. defaults to false
publish=${PUBLISH:-false}
if ! [[ "${publish}" =~ ^(true|false)$ ]]; then 
  echo "invalid value for PUBLISH: ${publish}"
  exit 1
fi

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
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -qq --assume-yes ${missing_packages}
fi

# verify dependencies
for package in ${missing_packages[@]}; do
  if ! command -v ${package} &> /dev/null
  then
      echo "required command ${package} could not be found"
      exit 1
  fi
done

# set up calling api
token="${TOKEN}"
api="${API:-https://api.webflow.com}"

# set names for the info we want to affect
site_short_name="${SITE_SHORT_NAME:-harperdb-official}"
collection_slug="${COLLECTION_SLUG:-legal}"

# we do have to know these ahead of time
item_slug="${ITEM_SLUG:-open-source-licenses-notices}"
item_name=${ITEM_NAME:-"Open Source Licenses & Notices"}

# output file from harperdb_opensource_license_generator
licenses_dir=${LICENSES_DIR:-utility/Docker/licenses/dependencies/}

# defaulting this at 9 for some growth, but also for using single digits in filename and content field
max_number_files=${MAX_NUMBER_FILES:-9}

# could be bumped if needed, but no idea how much
lines_per_content=${LINES_PER_CONTENT_FIELD:-5500}

# get site_id
site_id=$(curl --silent \
  --request GET \
  --url "${api}/sites?access_token=${token}" \
  --header 'accept: application/json'  \
  | jq -r ".[] | select(.shortName==\"${site_short_name}\") | ._id")

[ -z "${site_id}" ] && echo "failed to get site_id" && exit 1
echo "found site id as ${site_id}"

# get collection_id
collection_id=$(curl --silent \
  --request GET \
  --url "${api}/sites/${site_id}/collections?access_token=${token}" \
  --header 'accept: application/json' \
  | jq -r ".[] | select(.slug==\"${collection_slug}\") | ._id")

[ -z "${collection_id}" ] && echo "failed to get collection_id" && exit 1
echo "found collection id for legal collection slug as ${collection_id}"

# get item_id
item_id=$(curl --silent \
  --request GET \
  --url "${api}/collections/${collection_id}/items?access_token=${token}" \
  --header 'accept: application/json' \
  | jq -r ".items[] | select(.slug==\"${item_slug}\") | ._id")

[ -z "${item_id}" ] && echo "failed to get item_id" && exit 1
echo "found item id for os license item slug as ${item_id}"

# we are going to totally do things on the filesystem
directory=${WORK_DIR:-license-content}
prefix="content"

mkdir -p "${directory}"

# generate license file as markdown
declare -A licenses
declare -A packages
declare -A files

markdown_license_file=${MARKDOWN_LICENSE_FILE:-licenses.md}

# output header for markdown
echo "# Licenses" > "${markdown_license_file}"
echo >> "${markdown_license_file}"

# iterate through the files in the licenses_dir
for file in "${licenses_dir}"/*; do
  # reverse the file name back into package name
  package=$(echo -n "${file}" | sed -e 's/^.*\/license-//' -e 's/\.[^.]*$//' -e 's/^-/@/')
  [[ ${package} == @* ]] && package="${package/-/\/}"

  # set packages array that matches file > package
  packages["${file}"]="${package}"

  # set licenses array that matches md5sum > file which we will use for license contents. this gets overwritten for every duplicate
  checksum=$(md5sum ${file} | cut -d' ' -f1)
  licenses["${checksum}"]="${file}"

  # set files array that matches file > checksum
  files["${file}"]="${checksum}"
done

for checksum in "${!licenses[@]}"; do

  # generate header for this section
  echo >> "${markdown_license_file}"
  echo "## Packages" >> "${markdown_license_file}"
  echo >> "${markdown_license_file}"

  # if the license file is empty, lets build a table instead of a list
  if [ ! -s "${licenses[${checksum}]}" ]; then
    echo "Could not find license text for the following">> "${markdown_license_file}"
    echo >> "${markdown_license_file}"
#    echo "Dependency | License | Homepage" >> "${markdown_license_file}"
#    echo "---------- | ------- | --------" >> "${markdown_license_file}"
  fi

  # sort keys for file assoc array
  readarray -td '' files_keys_sorted < <(printf '%s\0' "${!files[@]}" | sort -z)

  # find and list all packages that match this checksum
  for file in "${files_keys_sorted[@]}"; do
    if [[ "${checksum}" == "${files[${file}]}" ]]; then
      if [ -s "${licenses[${checksum}]}" ]; then
        echo " - ${packages[${file}]}" >> "${markdown_license_file}"
      else
#        license_type=$(npm query "[name='${packages[${file}]}']" | jq -r '.[0] | .license ' || echo -n 'undefined')
#        package_homepage=$(npm query "[name='${packages[${file}]}']" | jq -r '.[0] | .homepage' || echo -n 'undefined')
#        echo " - [${packages[${file}]}](${package_homepage}) | ${license_type}" >> "${markdown_license_file}"
        echo " - ${packages[${file}]}" >> "${markdown_license_file}"
      fi
    fi
  done

  echo >> "${markdown_license_file}"

  # make sure the license file has content before we post the 'license' section. otherwise, we are covered in the table
  if [ -s "${licenses[${checksum}]}" ]; then
    echo "### License" >> "${markdown_license_file}"
    echo >> "${markdown_license_file}"
    echo '>```' >> "${markdown_license_file}"
    cat "${licenses[${checksum}]}" | sed -e 's/^/>/' >> "${markdown_license_file}"
    echo >> "${markdown_license_file}"
    echo '>```' >> "${markdown_license_file}"
  fi

  # break for next set of dependencies
  echo >> "${markdown_license_file}"
  echo "----------" >> "${markdown_license_file}"
  echo >> "${markdown_license_file}"
done

cat "${markdown_license_file}" \
| pandoc --quiet \
  --from markdown \
  --to html \
| csplit \
  --silent \
  --keep-files \
  --elide-empty-files \
  --prefix=${directory}/${prefix}- \
  --digits=1 \
  - \
  ${lines_per_content} \
  '{7}' \
  2>/dev/null || true

# patch collection item
# add json for field to field for patch_data
patch_data=$(jq --null-input --argjson json "{}" '{fields: $json}')

## build patch/patch data
patch_data=$(echo ${patch_data} | jq --arg slug ${item_slug} '.fields += {slug: $slug}')
patch_data=$(echo ${patch_data} | jq --arg name "${item_name}" '.fields += {name: $name}')
patch_data=$(echo ${patch_data} | jq '.fields += {_archived: false}')
patch_data=$(echo ${patch_data} | jq '.fields += {_draft: true}')

num_files=$(find "${directory}" -type f | wc -l | xargs)

echo "created ${num_files} files in ${directory} for upload" >> $GITHUB_STEP_SUMMARY
echo "created ${num_files} files in ${directory} for upload"

# checking to  make sure we created more than 1 file.
if [ "${num_files}" -le 1 ]; then
  echo "There are suspiciously few files created, so we are just going to bail" >> $GITHUB_STEP_SUMMARY
  echo "There are suspiciously few files created, so we are just going to bail"
  exit 1
fi

# add files that we have to content fields
[ -f "${directory}/${prefix}-0" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-0" '.fields += {"content": $new_content}')
[ -f "${directory}/${prefix}-1" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-1" '.fields += {"content-2": $new_content}')
[ -f "${directory}/${prefix}-2" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-2" '.fields += {"content-3": $new_content}')
[ -f "${directory}/${prefix}-3" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-3" '.fields += {"content-4": $new_content}')
[ -f "${directory}/${prefix}-4" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-4" '.fields += {"content-5": $new_content}')
[ -f "${directory}/${prefix}-5" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-5" '.fields += {"content-6": $new_content}')
[ -f "${directory}/${prefix}-6" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-6" '.fields += {"content-7": $new_content}')
[ -f "${directory}/${prefix}-7" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-7" '.fields += {"content-8": $new_content}')
[ -f "${directory}/${prefix}-8" ] && patch_data=$(echo ${patch_data} | jq --rawfile new_content "${directory}/${prefix}-8" '.fields += {"content-9": $new_content}')

exit 0

#if [[ "${publish}" == "false" ]]; then
#  echo "${patch_data}"
#else
#  echo "${patch_data}" | \
#    curl --silent \
#      --request PATCH \
#      --url "${api}/collections/${collection_id}/items/${item_id}?live=${publish}&access_token=${token}" \
#      --header 'accept: application/json' \
#      --header 'content-type: application/json' \
#      --data @-
#fi