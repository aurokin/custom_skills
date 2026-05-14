#!/usr/bin/env bash

HERMES_AGENT_ID="hermes-agent"
STANDARD_AGENTS=(codex opencode gemini-cli github-copilot claude-code)

compute_skills_agents() {
    local -n out_ref="$1"
    if [ -n "${SKILLS_AGENTS:-}" ]; then
        IFS=' ' read -r -a out_ref <<< "$SKILLS_AGENTS"
    else
        out_ref=("${STANDARD_AGENTS[@]}")
    fi
}

agents_include_hermes() {
    local -n agents_ref="$1"
    local agent
    for agent in "${agents_ref[@]}"; do
        if [ "$agent" = "$HERMES_AGENT_ID" ]; then
            return 0
        fi
    done
    return 1
}

agents_excluding_hermes() {
    local -n in_ref="$1"
    local -n out_ref="$2"
    local agent
    out_ref=()
    for agent in "${in_ref[@]}"; do
        if [ "$agent" != "$HERMES_AGENT_ID" ]; then
            out_ref+=("$agent")
        fi
    done
}
