#!/usr/bin/env bash

CATALOG_DIR="${SKILL_CATALOG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/catalog}"
GLOBAL_SPECS_FILE="${GLOBAL_SPECS_FILE:-$CATALOG_DIR/global-specs.txt}"
FAMILY_INDEX_FILE="${FAMILY_INDEX_FILE:-$CATALOG_DIR/families.tsv}"
FAMILY_SPECS_DIR="${FAMILY_SPECS_DIR:-$CATALOG_DIR/families}"

validate_spec_line() {
    local spec="$1"
    local file="$2"
    local line_number="$3"

    if [[ ! "$spec" =~ ^[^[:space:]@]+/[^[:space:]@]+(@[^[:space:]@]+)?$ ]]; then
        echo "Invalid skill spec in $file:$line_number: $spec" >&2
        return 1
    fi
}

spec_has_explicit_skill() {
    local spec="$1"
    [[ "$spec" == *"@"* ]]
}

spec_repo() {
    local spec="$1"

    if spec_has_explicit_skill "$spec"; then
        printf '%s\n' "${spec%@*}"
    else
        printf '%s\n' "$spec"
    fi
}

spec_skill() {
    local spec="$1"

    if spec_has_explicit_skill "$spec"; then
        printf '%s\n' "${spec##*@}"
    else
        printf '\n'
    fi
}

read_specs_file_into_array() {
    local file="$1"
    local target_name="$2"
    local -n target_ref="$target_name"
    local line
    local line_number=0

    target_ref=()
    while IFS= read -r line || [ -n "$line" ]; do
        line_number=$((line_number + 1))
        if [[ -z "$line" || "$line" == \#* ]]; then
            continue
        fi
        validate_spec_line "$line" "$file" "$line_number" || return 1
        target_ref+=("$line")
    done < "$file"
}

load_global_specs() {
    local target_name="$1"
    read_specs_file_into_array "$GLOBAL_SPECS_FILE" "$target_name"
}

list_family_names() {
    local family_name family_description
    local family_specs=()

    while IFS=$'\t' read -r family_name family_description; do
        if [[ -z "$family_name" || "$family_name" == \#* ]]; then
            continue
        fi
        if [ -f "$FAMILY_SPECS_DIR/$family_name.txt" ] && load_family_specs "$family_name" family_specs >/dev/null 2>&1; then
            printf '%s\n' "$family_name"
        fi
    done < "$FAMILY_INDEX_FILE"
}

get_family_description() {
    local family_name="$1"

    awk -F '\t' -v family_name="$family_name" '
        $1 == family_name {
            print $2
            exit
        }
    ' "$FAMILY_INDEX_FILE"
}

family_exists() {
    local family_name="$1"
    local family_specs_file="$FAMILY_SPECS_DIR/$family_name.txt"
    local family_specs=()

    [ -f "$family_specs_file" ] && load_family_specs "$family_name" family_specs >/dev/null 2>&1 && awk -F '\t' -v family_name="$family_name" '
        $1 == family_name {
            found = 1
            exit
        }
        END {
            exit(found ? 0 : 1)
        }
    ' "$FAMILY_INDEX_FILE"
}

load_family_specs() {
    local family_name="$1"
    local target_name="$2"
    local family_specs_file="$FAMILY_SPECS_DIR/$family_name.txt"

    if [ ! -f "$family_specs_file" ]; then
        echo "Unknown family: $family_name" >&2
        return 1
    fi

    read_specs_file_into_array "$family_specs_file" "$target_name"
}

load_specs_for_families() {
    local family_names_name="$1"
    local target_name="$2"
    local -n family_names_ref="$family_names_name"
    local -n target_ref="$target_name"
    local family_name
    local family_specs=()

    target_ref=()
    for family_name in "${family_names_ref[@]}"; do
        load_family_specs "$family_name" family_specs
        target_ref+=("${family_specs[@]}")
    done
}
