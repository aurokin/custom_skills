#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$REPO_DIR/skills/agents-md"
TARGET_FILE="$TARGET_DIR/SKILL.md"
UPSTREAM_URL="https://raw.githubusercontent.com/getsentry/skills/main/plugins/sentry-skills/skills/agents-md/SKILL.md"

warn() {
    echo "WARN: $*" >&2
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
}

main() {
    require_cmd curl
    require_cmd awk
    require_cmd grep
    require_cmd mktemp
    require_cmd mv

    mkdir -p "$TARGET_DIR"

    local upstream_tmp patched_tmp
    upstream_tmp="$(mktemp)"
    patched_tmp="$(mktemp)"
    trap 'rm -f "${upstream_tmp:-}" "${patched_tmp:-}"' EXIT

    curl -fsSL "$UPSTREAM_URL" -o "$upstream_tmp"

    local required_count
    required_count="$(grep -c '^### Commit Attribution$' "$upstream_tmp" || true)"

    if [ "$required_count" -ne 1 ] || ! grep -q '^## Example Structure$' "$upstream_tmp"; then
        warn "upstream structure changed; expected required and example headings were not found"
        return 0
    fi

    awk '
        BEGIN {
            skip_required = 0
            skip_example = 0
            in_example = 0
        }
        {
            if (skip_required) {
                if ($0 ~ /^### /) {
                    skip_required = 0
                } else {
                    next
                }
            }

            if (skip_example) {
                if ($0 ~ /^## /) {
                    skip_example = 0
                } else {
                    next
                }
            }

            if ($0 == "## Example Structure") {
                in_example = 1
            }

            if ($0 == "### Commit Attribution") {
                skip_required = 1
                next
            }

            if (in_example && $0 == "## Commit Attribution") {
                skip_example = 1
                next
            }

            print
        }
    ' "$upstream_tmp" > "$patched_tmp"

    if grep -q 'Commit Attribution' "$patched_tmp" || grep -q 'Co-Authored-By' "$patched_tmp"; then
        warn "patch did not fully remove commit attribution content; leaving existing file unchanged"
        return 0
    fi

    "$SCRIPT_DIR/test-agents-md.sh" "$patched_tmp"

    mv "$patched_tmp" "$TARGET_FILE"
    echo "Synced $TARGET_FILE"
}

main "$@"
