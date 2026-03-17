#!/usr/bin/env bash

# Reproduce this machine's skill setup on another computer.
# - Installs upstream global skills via the `skills` CLI
# - Removes deprecated agent-md-refactor if present
# - Links local custom skills from this repo into ~/.agents/skills
# - Optionally links OpenClaw-only skills when explicitly requested

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_BIN="${SKILLS_BIN:-skills}"
SKILLS_AGENTS="${SKILLS_AGENTS:-codex opencode gemini-cli github-copilot claude-code}"
LINK_OPENCLAW_SKILLS="${LINK_OPENCLAW_SKILLS:-0}"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
}

install_skill() {
    local spec="$1"
    shift
    echo "Installing: $spec"
    "$SKILLS_BIN" add "$spec" -g -a "$@" -y
}

main() {
    require_cmd "$SKILLS_BIN"

    local skills_agents=()
    IFS=' ' read -r -a skills_agents <<< "$SKILLS_AGENTS"
    if [ "${#skills_agents[@]}" -eq 0 ]; then
        echo "No SKILLS_AGENTS configured" >&2
        exit 1
    fi

    echo "Installing to ~/.agents/skills for agents: ${skills_agents[*]}"

    # Replace old AGENTS.md refactor skill with Sentry's agents-md.
    "$SKILLS_BIN" remove agent-md-refactor -g -y >/dev/null 2>&1 || true

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
        "openai/skills@playwright"
        "openai/skills@screenshot"
        "openai/skills@security-best-practices"
        "openai/skills@skill-creator"
        "openai/skills@spreadsheet"
        "steipete/clawdis@github"
        "vercel-labs/agent-skills@vercel-composition-patterns"
        "vercel-labs/agent-skills@vercel-react-best-practices"
        "vercel-labs/agent-skills@vercel-react-native-skills"
        "vercel-labs/agent-skills@web-design-guidelines"
        "vercel-labs/skills@find-skills"
    )

    for spec in "${specs[@]}"; do
        install_skill "$spec" "${skills_agents[@]}"
    done

    echo "Linking local repo skills..."
    "$SCRIPT_DIR/link-skills.sh"

    if [ "$LINK_OPENCLAW_SKILLS" = "1" ]; then
        echo "Linking OpenClaw-only repo skills..."
        "$SCRIPT_DIR/link-openclaw-skills.sh"
    else
        echo "Skipping OpenClaw skill linking (set LINK_OPENCLAW_SKILLS=1 to enable)."
    fi

    echo "Done."
}

main "$@"
