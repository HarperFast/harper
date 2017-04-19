#!/usr/bin/env bash
#!/bin/bash

searchHDB () {
    cd "${table_path}${search_field}"
    ls_search="./${ls_regex}/"

    files=($(find $ls_search -maxdepth 1 -mindepth 1 -type l  -printf "%l\n" 2>/dev/null | sort | uniq | awk '{sub(/..\//, "./"); print}'))
    array_length=${#files[@]}

    if [ $array_length -gt 0 ]
    then
        awk -v search="$awk_regex" 'function basename(file, a, n) {
            n = split(file, a, "/")
            return a[n]
        } {if (match($0, search)) print basename(FILENAME) }' ${files[@]}
    else
        echo ${files[@]}
    fi
}