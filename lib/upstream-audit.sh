#!/usr/bin/env bash

audit_warn() {
    echo "WARN: $*" >&2
}

declare -gA UPSTREAM_SKILL_NAME_CACHE=()
declare -gA UPSTREAM_SKILL_CACHE_STATUS=()

load_upstream_coverage_manifest() {
    local manifest_file="$1"

    jq -er '
        .repos
        | if type != "array" then error("expected .repos to be an array") else . end
        | .[]
        | [
            (.repo | if type == "string" and length > 0 then . else error("repo must be a non-empty string") end),
            ((.ignored // [])
                | if type == "array" then . else error("ignored must be an array") end
                | join(" "))
          ]
        | @tsv
    ' "$manifest_file"
}

load_coverage_manifest_into_maps() {
    local manifest_file="$1"
    local repos_name="$2"
    local ignored_name="$3"
    local manifest_output
    local coverage_repo ignored_list
    local -n repos_ref="$repos_name"
    local -n ignored_ref="$ignored_name"

    repos_ref=()
    ignored_ref=()

    manifest_output="$(load_upstream_coverage_manifest "$manifest_file")" || return 1
    while IFS=$'\t' read -r coverage_repo ignored_list; do
        [ -z "$coverage_repo" ] && continue
        repos_ref+=("$coverage_repo")
        ignored_ref["$coverage_repo"]="$ignored_list"
    done <<< "$manifest_output"
}

collect_upstream_skill_names() {
    local repo="$1"
    local tmp_dir repo_dir skills_root skill_file skill_name frontmatter_name
    local skill_file_count=0

    tmp_dir="$(mktemp -d)"
    repo_dir="$tmp_dir/repo"
    skills_root="$repo_dir/skills"

    if ! git clone --depth 1 "https://github.com/${repo}.git" "$repo_dir" >/dev/null 2>&1; then
        rm -rf "$tmp_dir"
        return 1
    fi

    while IFS= read -r -d '' skill_file; do
        skill_file_count=$((skill_file_count + 1))
        skill_name="$(basename "$(dirname "$skill_file")")"
        frontmatter_name="$(
            awk '
                BEGIN { in_yaml = 0 }
                /^---$/ {
                    if (in_yaml == 0) {
                        in_yaml = 1
                        next
                    }
                    exit
                }
                in_yaml && /^name:[[:space:]]*/ {
                    sub(/^name:[[:space:]]*/, "")
                    gsub(/^["'"'"']|["'"'"']$/, "")
                    print
                    exit
                }
            ' "$skill_file"
        )"
        if [ -n "$frontmatter_name" ]; then
            skill_name="$frontmatter_name"
        fi
        printf '%s\n' "$skill_name"
    done < <(find "$skills_root" -mindepth 2 -maxdepth 2 -name SKILL.md -print0 2>/dev/null)

    if [ "$skill_file_count" -eq 0 ]; then
        audit_warn "No skills/*/SKILL.md files found in $repo; repo layout may have changed"
        rm -rf "$tmp_dir"
        return 1
    fi

    rm -rf "$tmp_dir"
}

collect_upstream_skill_names_cached() {
    local repo="$1"
    local target_name="${2:-}"
    local cached_output

    if [[ -n "${UPSTREAM_SKILL_CACHE_STATUS[$repo]:-}" ]]; then
        if [ "${UPSTREAM_SKILL_CACHE_STATUS[$repo]}" -eq 0 ]; then
            cached_output="${UPSTREAM_SKILL_NAME_CACHE[$repo]}"
            if [ -n "$target_name" ]; then
                local -n target_ref="$target_name"
                target_ref="$cached_output"
            elif [ -n "$cached_output" ]; then
                printf '%s\n' "$cached_output"
            fi
            return 0
        fi
        return 1
    fi

    if ! cached_output="$(collect_upstream_skill_names "$repo" | sort -u)"; then
        UPSTREAM_SKILL_CACHE_STATUS["$repo"]=1
        return 1
    fi

    UPSTREAM_SKILL_NAME_CACHE["$repo"]="$cached_output"
    UPSTREAM_SKILL_CACHE_STATUS["$repo"]=0

    if [ -n "$target_name" ]; then
        local -n target_ref="$target_name"
        target_ref="$cached_output"
    elif [ -n "$cached_output" ]; then
        printf '%s\n' "$cached_output"
    fi
}

audit_repo_skill_coverage() {
    local repo="$1"
    local declared_list="$2"
    local ignored_list="$3"
    local upstream_output
    local -A declared_names=()
    local -A ignored_names=()
    local -A upstream_names=()
    local -a unexpected_names=()
    local -a missing_names=()
    local name

    for name in $declared_list; do
        declared_names["$name"]=1
    done
    for name in $ignored_list; do
        ignored_names["$name"]=1
    done

    if ! collect_upstream_skill_names_cached "$repo" upstream_output; then
        return 1
    fi

    while IFS= read -r name; do
        [ -z "$name" ] && continue
        upstream_names["$name"]=1
        if [[ -z "${declared_names[$name]:-}" && -z "${ignored_names[$name]:-}" ]]; then
            unexpected_names+=("$name")
        fi
    done <<< "$upstream_output"

    for name in "${!declared_names[@]}"; do
        if [[ -z "${upstream_names[$name]:-}" ]]; then
            missing_names+=("$name")
        fi
    done

    if [ "${#unexpected_names[@]}" -gt 0 ]; then
        audit_warn "Undeclared upstream skill(s) in $repo: ${unexpected_names[*]}"
    fi
    if [ "${#missing_names[@]}" -gt 0 ]; then
        audit_warn "Declared skill(s) no longer found in $repo: ${missing_names[*]}"
    fi

    if [ "${#unexpected_names[@]}" -gt 0 ] || [ "${#missing_names[@]}" -gt 0 ]; then
        return 2
    fi

    return 0
}
