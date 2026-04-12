#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_BIN="${SKILLS_BIN:-skills}"
DEFAULT_SKILLS_AGENTS="${SKILLS_AGENTS:-codex opencode gemini-cli github-copilot claude-code}"
SKILLS_AUDIT_REPO_COVERAGE="${SKILLS_AUDIT_REPO_COVERAGE:-1}"
FAMILY_UPSTREAM_COVERAGE_FILE="${FAMILY_UPSTREAM_COVERAGE_FILE:-$SCRIPT_DIR/catalog/family-coverage.json}"

# shellcheck source=lib/catalog.sh
source "$SCRIPT_DIR/lib/catalog.sh"
# shellcheck source=lib/upstream-audit.sh
source "$SCRIPT_DIR/lib/upstream-audit.sh"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
}

warn() {
    audit_warn "$@"
}

require_option_value() {
    local option_name="$1"
    local option_value="${2:-}"

    if [ -z "$option_value" ] || [[ "$option_value" == -* ]]; then
        echo "Missing value for $option_name" >&2
        exit 1
    fi
}

usage() {
    cat <<'EOF'
Usage: ./deploy-project-skills.sh [options]

Deploy curated skill families into a target directory using project-scoped
`skills add --copy` installs.

Options:
  --target DIR          Directory to install into
  --family NAME         Family to deploy; repeatable
  --all-families        Deploy every configured family
  --agents "A B"        Agents to install for
  --list-families       Print available families and exit
  --interactive         Force prompts even when stdin is not a TTY
  --dry-run             Print planned commands without executing them
  --yes                 Skip confirmation prompts
  --help                Show this help text

Examples:
  ./deploy-project-skills.sh --target ~/code/my-app --family expo --family convex --yes
  ./deploy-project-skills.sh --interactive
EOF
}

print_families() {
    local family_name
    while IFS= read -r family_name; do
        printf '%s\t%s\n' "$family_name" "$(get_family_description "$family_name")"
    done < <(list_family_names)
}

prompt_for_target() {
    local default_target="${1:-$PWD}"
    local response

    printf 'Target project directory [%s]: ' "$default_target" >&2
    read -r response
    if [ -z "$response" ]; then
        printf '%s\n' "$default_target"
    else
        printf '%s\n' "$response"
    fi
}

prompt_for_agents() {
    local default_agents="$1"
    local response

    printf 'Agents to install for [%s]: ' "$default_agents" >&2
    read -r response
    if [ -z "$response" ]; then
        printf '%s\n' "$default_agents"
    else
        printf '%s\n' "$response"
    fi
}

prompt_for_families() {
    local family_name
    local family_names=()
    local family_descriptions=()
    local response
    local token
    local index
    local selected=()
    local seen=""

    while IFS= read -r family_name; do
        family_names+=("$family_name")
        family_descriptions+=("$(get_family_description "$family_name")")
    done < <(list_family_names)

    echo "Available families:" >&2
    for index in "${!family_names[@]}"; do
        printf '  %d. %s - %s\n' \
            "$((index + 1))" \
            "${family_names[$index]}" \
            "${family_descriptions[$index]}" >&2
    done

    printf 'Select families by number or name (comma-separated, or "all"): ' >&2
    read -r response

    if [ -z "$response" ] || [ "$response" = "all" ]; then
        printf '%s\n' "${family_names[@]}"
        return 0
    fi

    response="${response//,/ }"
    for token in $response; do
        if [[ "$token" =~ ^[0-9]+$ ]]; then
            index=$((token - 1))
            if [ "$index" -lt 0 ] || [ "$index" -ge "${#family_names[@]}" ]; then
                echo "Invalid family selection: $token" >&2
                return 1
            fi
            token="${family_names[$index]}"
        fi

        if ! family_exists "$token"; then
            echo "Unknown family: $token" >&2
            return 1
        fi

        if [[ " $seen " != *" $token "* ]]; then
            selected+=("$token")
            seen+=" $token"
        fi
    done

    printf '%s\n' "${selected[@]}"
}

confirm_or_exit() {
    local prompt="$1"
    local response

    printf '%s [y/N]: ' "$prompt" >&2
    read -r response
    case "$response" in
        y|Y|yes|YES)
            return 0
            ;;
        *)
            echo "Cancelled." >&2
            exit 1
            ;;
    esac
}

resolve_target_repo() {
    local target_dir="$1"

    if [ ! -d "$target_dir" ]; then
        echo "Target directory does not exist: $target_dir" >&2
        return 1
    fi

    (
        cd "$target_dir"
        pwd -P
    )
}

dedupe_families() {
    local -n families_ref="$1"
    local family_name
    local deduped=()
    local seen=""

    for family_name in "${families_ref[@]}"; do
        if [[ " $seen " != *" $family_name "* ]]; then
            deduped+=("$family_name")
            seen+=" $family_name"
        fi
    done

    families_ref=("${deduped[@]}")
}

build_repo_batches() {
    local -n specs_ref="$1"
    local -n repo_order_ref="$2"
    local -n specs_by_repo_ref="$3"
    local spec repo skill_name
    local -A repo_install_all=()

    repo_order_ref=()
    specs_by_repo_ref=()
    for spec in "${specs_ref[@]}"; do
        repo="$(spec_repo "$spec")"
        skill_name="$(spec_skill "$spec")"
        if [[ -z "${specs_by_repo_ref[$repo]:-}" ]]; then
            repo_order_ref+=("$repo")
            specs_by_repo_ref["$repo"]=""
        fi
        if ! spec_has_explicit_skill "$spec"; then
            repo_install_all["$repo"]=1
            specs_by_repo_ref["$repo"]=""
        else
            if [[ -z "${repo_install_all[$repo]:-}" ]]; then
                if [[ -z "${specs_by_repo_ref[$repo]}" ]]; then
                    specs_by_repo_ref["$repo"]="$skill_name"
                else
                    specs_by_repo_ref["$repo"]+=" $skill_name"
                fi
            fi
        fi
    done
}

main() {
    local target_dir=""
    local agents_string="$DEFAULT_SKILLS_AGENTS"
    local list_families_only=0
    local use_all_families=0
    local force_interactive=0
    local dry_run=0
    local assume_yes=0
    local families=()

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --target)
                require_option_value "$1" "${2:-}"
                target_dir="$2"
                shift 2
                ;;
            --family)
                require_option_value "$1" "${2:-}"
                families+=("$2")
                shift 2
                ;;
            --all-families)
                use_all_families=1
                shift
                ;;
            --agents)
                require_option_value "$1" "${2:-}"
                agents_string="$2"
                shift 2
                ;;
            --list-families)
                list_families_only=1
                shift
                ;;
            --interactive)
                force_interactive=1
                shift
                ;;
            --dry-run)
                dry_run=1
                shift
                ;;
            --yes)
                assume_yes=1
                shift
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                echo "Unknown option: $1" >&2
                usage >&2
                exit 1
                ;;
        esac
    done

    if [ "$list_families_only" -eq 1 ]; then
        print_families
        exit 0
    fi

    if [ "$dry_run" -ne 1 ]; then
        require_cmd "$SKILLS_BIN"
    fi

    local interactive_mode=0
    if [ "$force_interactive" -eq 1 ]; then
        interactive_mode=1
    elif [ -t 0 ] && [ -z "$target_dir" ] && [ "${#families[@]}" -eq 0 ] && [ "$use_all_families" -eq 0 ]; then
        interactive_mode=1
    fi

    if [ "$interactive_mode" -eq 1 ]; then
        target_dir="$(prompt_for_target "${target_dir:-$PWD}")"
        agents_string="$(prompt_for_agents "$agents_string")"
        if [ "$use_all_families" -eq 0 ] && [ "${#families[@]}" -eq 0 ]; then
            mapfile -t families < <(prompt_for_families)
        fi
    fi

    if [ -z "$target_dir" ]; then
        echo "Missing required option: --target" >&2
        usage >&2
        exit 1
    fi

    if [ "$use_all_families" -eq 1 ]; then
        mapfile -t families < <(list_family_names)
    fi

    if [ "${#families[@]}" -eq 0 ]; then
        echo "Select at least one family with --family or --all-families" >&2
        exit 1
    fi

    dedupe_families families

    local family_name
    for family_name in "${families[@]}"; do
        if ! family_exists "$family_name"; then
            echo "Unknown family: $family_name" >&2
            exit 1
        fi
    done

    local install_root
    install_root="$(resolve_target_repo "$target_dir")"

    local skills_agents=()
    IFS=' ' read -r -a skills_agents <<< "$agents_string"
    if [ "${#skills_agents[@]}" -eq 0 ]; then
        echo "No agents configured" >&2
        exit 1
    fi

    local specs=()
    load_specs_for_families families specs

    local -A declared_by_repo=()
    local spec repo skill_name
    for spec in "${specs[@]}"; do
        repo="$(spec_repo "$spec")"
        skill_name="$(spec_skill "$spec")"
        if ! spec_has_explicit_skill "$spec"; then
            declared_by_repo["$repo"]="__ALL__"
        elif [[ -z "${declared_by_repo[$repo]:-}" ]]; then
            declared_by_repo["$repo"]="$skill_name"
        else
            if [[ "${declared_by_repo[$repo]}" != "__ALL__" ]]; then
                declared_by_repo["$repo"]+=" $skill_name"
            fi
        fi
    done

    local -a coverage_repos=()
    local -A ignored_by_repo=()
    if [ "$SKILLS_AUDIT_REPO_COVERAGE" = "1" ]; then
        if [ ! -f "$FAMILY_UPSTREAM_COVERAGE_FILE" ]; then
            warn "Skipping family repo coverage audit because manifest is missing: $FAMILY_UPSTREAM_COVERAGE_FILE"
        elif ! command -v jq >/dev/null 2>&1; then
            warn "Skipping family repo coverage audit because jq is not installed"
        elif ! command -v git >/dev/null 2>&1; then
            warn "Skipping family repo coverage audit because git is not installed"
        elif ! load_coverage_manifest_into_maps "$FAMILY_UPSTREAM_COVERAGE_FILE" coverage_repos ignored_by_repo; then
            warn "Skipping family repo coverage audit because manifest is invalid: $FAMILY_UPSTREAM_COVERAGE_FILE"
        fi
    fi

    local repo_order=()
    local -A specs_by_repo=()
    build_repo_batches specs repo_order specs_by_repo

    echo "Deploying skills to target directory: $install_root"
    echo "Agents: ${skills_agents[*]}"
    echo "Families: ${families[*]}"
    echo ""
    echo "Planned installs:"

    local repo repo_skills
    for repo in "${repo_order[@]}"; do
        repo_skills=()
        IFS=' ' read -r -a repo_skills <<< "${specs_by_repo[$repo]}"
        if [ "${#repo_skills[@]}" -eq 0 ]; then
            echo "  $repo: (all skills)"
        else
            echo "  $repo: ${repo_skills[*]}"
        fi
    done

    if [ "$dry_run" -eq 1 ]; then
        exit 0
    fi

    if [ "$SKILLS_AUDIT_REPO_COVERAGE" = "1" ] && [ "${#coverage_repos[@]}" -gt 0 ]; then
        echo ""
        echo "Auditing curated family repos..."
        local coverage_repo
        local audit_warnings=0
        local audit_failures=0
        for coverage_repo in "${coverage_repos[@]}"; do
            if [[ -z "${declared_by_repo[$coverage_repo]:-}" ]]; then
                continue
            fi
            if [[ "${declared_by_repo[$coverage_repo]}" == "__ALL__" ]]; then
                continue
            fi
            if audit_repo_skill_coverage \
                "$coverage_repo" \
                "${declared_by_repo[$coverage_repo]}" \
                "${ignored_by_repo[$coverage_repo]:-}"; then
                :
            else
                case $? in
                    1)
                        audit_failures=$((audit_failures + 1))
                        warn "Skipping family repo coverage audit for $coverage_repo"
                        ;;
                    2)
                        audit_warnings=$((audit_warnings + 1))
                        ;;
                esac
            fi
        done
        if [ "$audit_warnings" -eq 0 ] && [ "$audit_failures" -eq 0 ]; then
            echo "  No family coverage drift found."
        fi
    fi

    if [ "$assume_yes" -ne 1 ]; then
        confirm_or_exit "Proceed with project skill deployment?"
    fi

    for repo in "${repo_order[@]}"; do
        repo_skills=()
        IFS=' ' read -r -a repo_skills <<< "${specs_by_repo[$repo]}"
        (
            cd "$install_root"
            if [ "${#repo_skills[@]}" -eq 0 ]; then
                "$SKILLS_BIN" add "$repo" -a "${skills_agents[@]}" --copy -y
            else
                "$SKILLS_BIN" add "$repo" -a "${skills_agents[@]}" -s "${repo_skills[@]}" --copy -y
            fi
        )
    done

    echo ""
    echo "Done."
}

main "$@"
