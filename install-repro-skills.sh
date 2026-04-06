#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_BIN="${SKILLS_BIN:-skills}"
SKILLS_AGENTS="${SKILLS_AGENTS:-codex opencode gemini-cli github-copilot claude-code}"
SKILLS_AUDIT_REPO_COVERAGE="${SKILLS_AUDIT_REPO_COVERAGE:-1}"
UPSTREAM_COVERAGE_FILE="${UPSTREAM_COVERAGE_FILE:-$SCRIPT_DIR/upstream-coverage.json}"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
}

warn() {
    echo "WARN: $*" >&2
}

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
        warn "No skills/*/SKILL.md files found in $repo; repo layout may have changed"
        rm -rf "$tmp_dir"
        return 1
    fi

    rm -rf "$tmp_dir"
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

    if ! upstream_output="$(collect_upstream_skill_names "$repo" | sort -u)"; then
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
        warn "Undeclared upstream skill(s) in $repo: ${unexpected_names[*]}"
    fi
    if [ "${#missing_names[@]}" -gt 0 ]; then
        warn "Declared skill(s) no longer found in $repo: ${missing_names[*]}"
    fi

    if [ "${#unexpected_names[@]}" -gt 0 ] || [ "${#missing_names[@]}" -gt 0 ]; then
        return 2
    fi

    return 0
}

main() {
    require_cmd "$SKILLS_BIN"
    require_cmd jq

    local skills_agents=()
    IFS=' ' read -r -a skills_agents <<< "$SKILLS_AGENTS"
    if [ "${#skills_agents[@]}" -eq 0 ]; then
        echo "No SKILLS_AGENTS configured" >&2
        exit 1
    fi

    # Source of truth: desired skill specs.
    # Keep this list fully explicit so stale-skill removal can compare exact
    # names and the curated set does not drift when upstream repos add skills.
    local specs=(
        "anthropics/skills@frontend-design"
        "anthropics/skills@webapp-testing"
        "expo/skills@building-native-ui"
        "expo/skills@expo-api-routes"
        "expo/skills@expo-cicd-workflows"
        "expo/skills@expo-deployment"
        "expo/skills@expo-dev-client"
        "expo/skills@expo-tailwind-setup"
        "expo/skills@native-data-fetching"
        "expo/skills@upgrading-expo"
        "expo/skills@use-dom"
        "openai/skills@openai-docs"
        "openai/skills@pdf"
        "openai/skills@screenshot"
        "openai/skills@security-best-practices"
        "openai/skills@skill-creator"
        "openai/skills@spreadsheet"
        "steipete/clawdis@github"
        "steipete/clawdis@tmux"
        "vercel-labs/agent-browser@agent-browser"
        "vercel-labs/agent-browser@agentcore"
        "vercel-labs/agent-browser@dogfood"
        "vercel-labs/agent-browser@electron"
        "vercel-labs/agent-browser@slack"
        "vercel-labs/agent-browser@vercel-sandbox"
        "vercel-labs/agent-skills@vercel-composition-patterns"
        "vercel-labs/agent-skills@vercel-react-best-practices"
        "vercel-labs/agent-skills@vercel-react-native-skills"
        "vercel-labs/agent-skills@web-design-guidelines"
        "vercel-labs/skills@find-skills"
        "dedene/raindrop-cli@raindrop-cli"
        "waynesutton/convexskills@convex"
        "waynesutton/convexskills@convex-agents"
        "waynesutton/convexskills@convex-best-practices"
        "waynesutton/convexskills@convex-component-authoring"
        "waynesutton/convexskills@convex-cron-jobs"
        "waynesutton/convexskills@convex-file-storage"
        "waynesutton/convexskills@convex-functions"
        "waynesutton/convexskills@convex-http-actions"
        "waynesutton/convexskills@convex-migrations"
        "waynesutton/convexskills@convex-realtime"
        "waynesutton/convexskills@convex-schema-validator"
        "waynesutton/convexskills@convex-security-audit"
        "waynesutton/convexskills@convex-security-check"
    )

    echo "Syncing global skills for agents: ${skills_agents[*]}"

    # Build set of exact expected skill names from the curated specs.
    local -A desired_names=()
    local -A declared_by_repo=()
    for spec in "${specs[@]}"; do
        local repo="${spec%@*}"
        local name="${spec##*@}"
        desired_names["${spec##*@}"]=1
        if [[ -z "${declared_by_repo[$repo]:-}" ]]; then
            declared_by_repo["$repo"]="$name"
        else
            declared_by_repo["$repo"]+=" $name"
        fi
    done

    local -a coverage_repos=()
    local -A ignored_by_repo=()
    if [ "$SKILLS_AUDIT_REPO_COVERAGE" = "1" ]; then
        if [ ! -f "$UPSTREAM_COVERAGE_FILE" ]; then
            warn "Skipping upstream repo coverage audit because manifest is missing: $UPSTREAM_COVERAGE_FILE"
        else
            local coverage_manifest
            if ! coverage_manifest="$(load_upstream_coverage_manifest "$UPSTREAM_COVERAGE_FILE")"; then
                warn "Skipping upstream repo coverage audit because manifest is invalid: $UPSTREAM_COVERAGE_FILE"
            else
                while IFS=$'\t' read -r coverage_repo ignored_list; do
                    [ -z "$coverage_repo" ] && continue
                    coverage_repos+=("$coverage_repo")
                    ignored_by_repo["$coverage_repo"]="$ignored_list"
                done <<< "$coverage_manifest"
            fi
        fi
    fi

    # Get currently installed global skill names (only ~/.agents/skills/).
    # The skills CLI ignores symlinks, so locally-linked skills from
    # link-skills.sh are naturally excluded.
    local -A installed_names=()
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        installed_names["$name"]=1
    done < <("$SKILLS_BIN" list -g --json | jq -r --arg home "$HOME" \
        '.[] | select(.path | startswith($home + "/.agents/skills/")) | .name')

    # --- Phase 1: Remove stale skills ---
    echo ""
    echo "Checking for stale skills..."
    local removed=0
    for name in "${!installed_names[@]}"; do
        if [[ -z "${desired_names[$name]:-}" ]]; then
            echo "  Removing: $name"
            "$SKILLS_BIN" remove -g "$name" -y || true
            removed=$((removed + 1))
        fi
    done
    if [ "$removed" -eq 0 ]; then
        echo "  No stale skills to remove."
    else
        echo "  Removed $removed skill(s)."
    fi

    # Clean up broken symlinks in skills directories
    local skills_target
    for skills_target in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
        if [ -d "$skills_target" ]; then
            while IFS= read -r link; do
                echo "  Cleaned broken symlink: $(basename "$link") (in $skills_target)"
            done < <(find "$skills_target" -maxdepth 1 -type l ! -exec test -e {} \; -print -delete 2>/dev/null)
        fi
    done

    # --- Phase 2: Update existing skills ---
    echo ""
    echo "Updating existing skills..."
    "$SKILLS_BIN" update

    # --- Coverage audit: full-coverage repos should not gain silent skills ---
    if [ "$SKILLS_AUDIT_REPO_COVERAGE" = "1" ]; then
        echo ""
        echo "Auditing full-coverage upstream repos..."
        if [ "${#coverage_repos[@]}" -eq 0 ]; then
            warn "Skipping upstream repo coverage audit because no coverage repos are configured"
        elif ! command -v git >/dev/null 2>&1; then
            warn "Skipping upstream repo coverage audit because git is not installed"
        else
            local coverage_repo
            local audit_warnings=0
            local audit_failures=0
            for coverage_repo in "${coverage_repos[@]}"; do
                if audit_repo_skill_coverage \
                    "$coverage_repo" \
                    "${declared_by_repo[$coverage_repo]:-}" \
                    "${ignored_by_repo[$coverage_repo]:-}"; then
                    :
                else
                    case $? in
                        1)
                            audit_failures=$((audit_failures + 1))
                            warn "Skipping upstream repo coverage audit for $coverage_repo"
                            ;;
                        2)
                            audit_warnings=$((audit_warnings + 1))
                            ;;
                    esac
                fi
            done
            if [ "$audit_warnings" -eq 0 ] && [ "$audit_failures" -eq 0 ]; then
                echo "  No upstream coverage drift found."
            fi
        fi
    fi

    # --- Phase 3: Add missing skills ---
    echo ""
    echo "Adding skills..."
    local -A missing_by_repo=()
    local repo_order=()
    for spec in "${specs[@]}"; do
        local repo="${spec%@*}"
        local name="${spec##*@}"
        if [[ -z "${installed_names[$name]:-}" ]]; then
            if [[ -z "${missing_by_repo[$repo]:-}" ]]; then
                repo_order+=("$repo")
                missing_by_repo["$repo"]="$name"
            else
                missing_by_repo["$repo"]+=" $name"
            fi
        fi
    done
    if [ "${#repo_order[@]}" -eq 0 ]; then
        echo "  No skills to add."
    else
        local repo
        for repo in "${repo_order[@]}"; do
            local repo_skills=()
            IFS=' ' read -r -a repo_skills <<< "${missing_by_repo[$repo]}"
            echo "  Adding from $repo: ${repo_skills[*]}"
            "$SKILLS_BIN" add "$repo" -g -a "${skills_agents[@]}" -s "${repo_skills[@]}" -y
        done
    fi

    # --- Phase 4: Link local skills ---
    echo ""
    echo "Linking local repo skills..."
    "$SCRIPT_DIR/link-skills.sh"

    echo ""
    echo "Done."
}

main "$@"
