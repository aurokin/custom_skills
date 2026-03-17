#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_BIN="${SKILLS_BIN:-skills}"
SKILLS_AGENTS="${SKILLS_AGENTS:-codex opencode gemini-cli github-copilot claude-code}"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
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

    # Source of truth: desired skill specs
    # Use "owner/repo@skill-name" for specific skills from multi-skill repos.
    # Specs without @ install all skills from the repo.
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
        "getsentry/skills@agents-md"
        "openai/skills@openai-docs"
        "openai/skills@pdf"
        "openai/skills@screenshot"
        "openai/skills@security-best-practices"
        "openai/skills@skill-creator"
        "openai/skills@spreadsheet"
        "steipete/clawdis@github"
        "steipete/clawdis@tmux"
        "vercel-labs/agent-browser"
        "vercel-labs/agent-skills@vercel-composition-patterns"
        "vercel-labs/agent-skills@vercel-react-best-practices"
        "vercel-labs/agent-skills@vercel-react-native-skills"
        "vercel-labs/agent-skills@web-design-guidelines"
        "vercel-labs/skills@find-skills"
        "waynesutton/convexskills"
    )

    echo "Syncing global skills for agents: ${skills_agents[*]}"

    # Build set of expected skill names from @-targeted specs.
    # Non-@ specs install all skills from a repo; we can't predict their
    # names, so they are excluded from the removal comparison but always
    # re-added to stay current.
    local -A desired_names=()
    for spec in "${specs[@]}"; do
        if [[ "$spec" == *@* ]]; then
            desired_names["${spec##*@}"]=1
        fi
    done

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
            ((removed++))
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
            find "$skills_target" -maxdepth 1 -xtype l -print -delete 2>/dev/null | while IFS= read -r link; do
                echo "  Cleaned broken symlink: $(basename "$link") (in $skills_target)"
            done
        fi
    done

    # --- Phase 2: Update existing skills ---
    echo ""
    echo "Updating existing skills..."
    "$SKILLS_BIN" update

    # --- Phase 3: Add missing skills ---
    echo ""
    echo "Adding skills..."
    for spec in "${specs[@]}"; do
        if [[ "$spec" == *@* ]]; then
            local name="${spec##*@}"
            if [[ -z "${installed_names[$name]:-}" ]]; then
                echo "  Adding: $spec"
                "$SKILLS_BIN" add "$spec" -g -a "${skills_agents[@]}" -y
            fi
        else
            # Non-targeted specs: always run to ensure they're installed/current
            echo "  Adding/ensuring: $spec"
            "$SKILLS_BIN" add "$spec" -g -a "${skills_agents[@]}" -y
        fi
    done

    # --- Phase 4: Link local skills ---
    echo ""
    echo "Linking local repo skills..."
    "$SCRIPT_DIR/link-skills.sh"

    echo ""
    echo "Done."
}

main "$@"
