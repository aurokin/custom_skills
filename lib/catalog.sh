#!/usr/bin/env bash

REPO_ROOT="${SKILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CATALOG_DIR="${SKILL_CATALOG_DIR:-$REPO_ROOT/catalog}"
GLOBAL_SPECS_FILE="${GLOBAL_SPECS_FILE:-$CATALOG_DIR/global-specs.txt}"
FAMILY_INDEX_FILE="${FAMILY_INDEX_FILE:-$CATALOG_DIR/families.tsv}"
FAMILY_SPECS_DIR="${FAMILY_SPECS_DIR:-$CATALOG_DIR/families}"
LOCAL_SKILLS_CONFIG_FILE="${LOCAL_SKILLS_CONFIG_FILE:-$REPO_ROOT/.skills.local.json}"
LOCAL_SKILLS_CONFIG_STATUS="${LOCAL_SKILLS_CONFIG_STATUS:-unchecked}"

validate_spec_line() {
    local spec="$1"
    local file="$2"
    local line_number="$3"

    if [[ ! "$spec" =~ ^[^[:space:]@]+/[^[:space:]@]+(@[^[:space:]@]+)?$ ]]; then
        echo "Invalid skill spec in $file:$line_number: $spec" >&2
        return 1
    fi
}

validate_explicit_spec_line() {
    local spec="$1"
    local file="$2"
    local line_number="$3"

    validate_spec_line "$spec" "$file" "$line_number" || return 1
    if ! spec_has_explicit_skill "$spec"; then
        echo "Explicit skill spec required in $file:$line_number: $spec" >&2
        return 1
    fi
}

validate_family_name() {
    local family_name="$1"
    local file="$2"
    local field_name="$3"

    if [[ -z "$family_name" || "$family_name" =~ [[:space:]] ]]; then
        echo "Invalid family name in $file:$field_name: $family_name" >&2
        return 1
    fi
}

validate_family_description() {
    local description="$1"
    local file="$2"
    local field_name="$3"

    if [ -z "$description" ] || [[ "$description" == *$'\t'* ]] || [[ "$description" == *$'\n'* ]]; then
        echo "Invalid family description in $file:$field_name" >&2
        return 1
    fi
}

dedupe_array() {
    local target_name="$1"
    local -n target_ref="$target_name"
    local value
    local deduped=()
    local -A seen=()

    for value in "${target_ref[@]}"; do
        [ -z "$value" ] && continue
        if [[ -n "${seen[$value]:-}" ]]; then
            continue
        fi
        deduped+=("$value")
        seen["$value"]=1
    done

    target_ref=("${deduped[@]}")
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

curated_family_declared_in_index() {
    local family_name="$1"

    awk -F '\t' -v family_name="$family_name" '
        $1 == family_name {
            found = 1
            exit
        }
        END {
            exit(found ? 0 : 1)
        }
    ' "$FAMILY_INDEX_FILE"
}

load_curated_family_specs() {
    local family_name="$1"
    local target_name="$2"
    local family_specs_file="$FAMILY_SPECS_DIR/$family_name.txt"

    if [ ! -f "$family_specs_file" ]; then
        echo "Unknown family: $family_name" >&2
        return 1
    fi

    read_specs_file_into_array "$family_specs_file" "$target_name"
}

curated_family_exists() {
    local family_name="$1"
    local family_specs=()

    [ -f "$FAMILY_SPECS_DIR/$family_name.txt" ] &&
        curated_family_declared_in_index "$family_name" &&
        load_curated_family_specs "$family_name" family_specs >/dev/null 2>&1
}

ensure_local_skills_config_valid() {
    local config_file="$LOCAL_SKILLS_CONFIG_FILE"
    local custom_family_entry
    local field_name
    local family_name
    local description
    local spec
    local specs_length

    case "$LOCAL_SKILLS_CONFIG_STATUS" in
        valid)
            return 0
            ;;
        absent)
            return 1
            ;;
    esac

    if [ ! -f "$config_file" ]; then
        LOCAL_SKILLS_CONFIG_STATUS="absent"
        return 1
    fi

    if ! command -v jq >/dev/null 2>&1; then
        echo "Missing required command: jq (needed for $config_file)" >&2
        return 2
    fi

    if ! jq -e '
        type == "object" and
        ((.globalSpecs // []) | type == "array") and
        ((.excludeGlobalSpecs // []) | type == "array") and
        ((.familySpecs // {}) | type == "object") and
        ((.excludeFamilySpecs // {}) | type == "object") and
        ((.customFamilies // {}) | type == "object") and
        all((.familySpecs // {})[]?; type == "array") and
        all((.excludeFamilySpecs // {})[]?; type == "array") and
        all((.customFamilies // {})[]?;
            type == "object" and
            (.description | type == "string") and
            (.specs | type == "array")
        )
    ' "$config_file" >/dev/null; then
        echo "Invalid local skills config in $config_file" >&2
        return 2
    fi

    while IFS=$'\t' read -r field_name spec; do
        [ -z "$field_name" ] && continue
        validate_spec_line "$spec" "$config_file" "$field_name" || return 2
    done < <(jq -r '
        (.globalSpecs // [])
        | to_entries[]
        | "globalSpecs[\(.key)]\t\(.value)"
    ' "$config_file")

    while IFS=$'\t' read -r field_name spec; do
        [ -z "$field_name" ] && continue
        validate_explicit_spec_line "$spec" "$config_file" "$field_name" || return 2
    done < <(jq -r '
        (.excludeGlobalSpecs // [])
        | to_entries[]
        | "excludeGlobalSpecs[\(.key)]\t\(.value)"
    ' "$config_file")

    while IFS= read -r family_name; do
        [ -z "$family_name" ] && continue
        validate_family_name "$family_name" "$config_file" "familySpecs.$family_name" || return 2
        if ! curated_family_exists "$family_name"; then
            echo "Unknown curated family in $config_file:familySpecs.$family_name" >&2
            return 2
        fi
    done < <(jq -r '(.familySpecs // {}) | keys_unsorted[]?' "$config_file")

    while IFS= read -r family_name; do
        [ -z "$family_name" ] && continue
        validate_family_name "$family_name" "$config_file" "excludeFamilySpecs.$family_name" || return 2
        if ! curated_family_exists "$family_name"; then
            echo "Unknown curated family in $config_file:excludeFamilySpecs.$family_name" >&2
            return 2
        fi
    done < <(jq -r '(.excludeFamilySpecs // {}) | keys_unsorted[]?' "$config_file")

    while IFS=$'\t' read -r field_name spec; do
        [ -z "$field_name" ] && continue
        validate_spec_line "$spec" "$config_file" "$field_name" || return 2
    done < <(jq -r '
        (.familySpecs // {})
        | to_entries[] as $family
        | $family.value
        | to_entries[]
        | "familySpecs[\($family.key)][\(.key)]\t\(.value)"
    ' "$config_file")

    while IFS=$'\t' read -r field_name spec; do
        [ -z "$field_name" ] && continue
        validate_explicit_spec_line "$spec" "$config_file" "$field_name" || return 2
    done < <(jq -r '
        (.excludeFamilySpecs // {})
        | to_entries[] as $family
        | $family.value
        | to_entries[]
        | "excludeFamilySpecs[\($family.key)][\(.key)]\t\(.value)"
    ' "$config_file")

    while IFS= read -r custom_family_entry; do
        [ -z "$custom_family_entry" ] && continue
        family_name="$(jq -r '.key' <<< "$custom_family_entry")"
        description="$(jq -r '.value.description' <<< "$custom_family_entry")"
        specs_length="$(jq -r '.value.specs | length' <<< "$custom_family_entry")"
        validate_family_name "$family_name" "$config_file" "customFamilies.$family_name" || return 2
        validate_family_description "$description" "$config_file" "customFamilies.$family_name.description" || return 2
        if [ "$specs_length" -eq 0 ]; then
            echo "Custom family must define at least one spec in $config_file:customFamilies.$family_name.specs" >&2
            return 2
        fi
        if curated_family_declared_in_index "$family_name"; then
            echo "Custom family conflicts with curated family in $config_file: $family_name" >&2
            return 2
        fi
    done < <(jq -c '
        (.customFamilies // {})
        | to_entries[]
    ' "$config_file")

    while IFS=$'\t' read -r field_name spec; do
        [ -z "$field_name" ] && continue
        validate_spec_line "$spec" "$config_file" "$field_name" || return 2
    done < <(jq -r '
        (.customFamilies // {})
        | to_entries[] as $family
        | $family.value.specs
        | to_entries[]
        | "customFamilies[\($family.key)].specs[\(.key)]\t\(.value)"
    ' "$config_file")

    LOCAL_SKILLS_CONFIG_STATUS="valid"
    return 0
}

append_local_global_specs() {
    local target_name="$1"
    local -n target_ref="$target_name"
    local status=0
    local spec

    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            return 0
        fi
        return 1
    fi

    while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        target_ref+=("$spec")
    done < <(jq -r '.globalSpecs[]?' "$LOCAL_SKILLS_CONFIG_FILE")
}

load_local_global_exclude_specs() {
    local target_name="$1"
    local -n target_ref="$target_name"
    local status=0
    local spec

    target_ref=()

    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            return 0
        fi
        return 1
    fi

    while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        target_ref+=("$spec")
    done < <(jq -r '.excludeGlobalSpecs[]?' "$LOCAL_SKILLS_CONFIG_FILE")

    dedupe_array "$target_name"
}

load_local_family_exclude_specs() {
    local family_name="$1"
    local target_name="$2"
    local -n target_ref="$target_name"
    local status=0
    local spec

    target_ref=()

    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            return 0
        fi
        return 1
    fi

    while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        target_ref+=("$spec")
    done < <(jq -r --arg family_name "$family_name" '.excludeFamilySpecs[$family_name][]?' "$LOCAL_SKILLS_CONFIG_FILE")

    dedupe_array "$target_name"
}

append_local_family_specs() {
    local family_name="$1"
    local target_name="$2"
    local -n target_ref="$target_name"
    local status=0
    local spec

    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            return 0
        fi
        return 1
    fi

    while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        target_ref+=("$spec")
    done < <(jq -r --arg family_name "$family_name" '.familySpecs[$family_name][]?' "$LOCAL_SKILLS_CONFIG_FILE")
}

load_custom_family_specs() {
    local family_name="$1"
    local target_name="$2"
    local -n target_ref="$target_name"
    local status=0
    local spec

    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            echo "Unknown family: $family_name" >&2
            return 1
        fi
        return 2
    fi

    target_ref=()
    while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        target_ref+=("$spec")
    done < <(jq -r --arg family_name "$family_name" '.customFamilies[$family_name].specs[]?' "$LOCAL_SKILLS_CONFIG_FILE")

    if [ "${#target_ref[@]}" -eq 0 ]; then
        echo "Unknown family: $family_name" >&2
        return 1
    fi

    dedupe_array "$target_name"
}

load_global_specs() {
    local target_name="$1"
    local -n target_ref="$target_name"

    read_specs_file_into_array "$GLOBAL_SPECS_FILE" "$target_name"
    append_local_global_specs "$target_name" || return 1
    dedupe_array "$target_name"
}

list_family_names() {
    local family_name family_description
    local family_specs=()

    while IFS=$'\t' read -r family_name family_description; do
        if [[ -z "$family_name" || "$family_name" == \#* ]]; then
            continue
        fi
        if curated_family_exists "$family_name"; then
            printf '%s\n' "$family_name"
        fi
    done < "$FAMILY_INDEX_FILE"

    local status=0
    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -ne 1 ]; then
            return 1
        fi
        return 0
    fi

    while IFS= read -r family_name; do
        [ -z "$family_name" ] && continue
        printf '%s\n' "$family_name"
    done < <(jq -r '(.customFamilies // {}) | keys_unsorted[]?' "$LOCAL_SKILLS_CONFIG_FILE")
}

get_family_description() {
    local family_name="$1"

    local status=0
    local custom_description=""
    if ensure_local_skills_config_valid; then
        custom_description="$(jq -r --arg family_name "$family_name" '.customFamilies[$family_name].description // empty' "$LOCAL_SKILLS_CONFIG_FILE")"
        if [ -n "$custom_description" ]; then
            printf '%s\n' "$custom_description"
            return 0
        fi
    else
        status=$?
        if [ "$status" -ne 1 ]; then
            return 1
        fi
    fi

    awk -F '\t' -v family_name="$family_name" '
        $1 == family_name {
            print $2
            exit
        }
    ' "$FAMILY_INDEX_FILE"
}

family_exists() {
    local family_name="$1"
    local family_specs=()
    local status=0

    if curated_family_exists "$family_name"; then
        return 0
    fi

    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            return 1
        fi
        return 2
    fi

    load_custom_family_specs "$family_name" family_specs >/dev/null 2>&1
}

load_family_specs() {
    local family_name="$1"
    local target_name="$2"
    local status=0

    if curated_family_exists "$family_name"; then
        load_curated_family_specs "$family_name" "$target_name" || return 1
        append_local_family_specs "$family_name" "$target_name" || return 1
        dedupe_array "$target_name"
        return 0
    fi

    if ensure_local_skills_config_valid; then
        status=0
    else
        status=$?
        if [ "$status" -eq 1 ]; then
            echo "Unknown family: $family_name" >&2
            return 1
        fi
        return 2
    fi

    load_custom_family_specs "$family_name" "$target_name"
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

    dedupe_array "$target_name"
}
