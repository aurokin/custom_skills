#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SCRIPT="$REPO_DIR/install-repro-skills.sh"
GLOBAL_SPECS_FILE="$REPO_DIR/catalog/global-specs.txt"
MANIFEST_TEMPLATE="$REPO_DIR/upstream-coverage.json"
ORIGINAL_PATH="$PATH"
TESTS_RUN=0

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_contains() {
    local file="$1"
    local needle="$2"
    if ! grep -Fq -- "$needle" "$file"; then
        echo "--- $file ---" >&2
        cat "$file" >&2
        echo "------------" >&2
        fail "expected to find: $needle"
    fi
}

assert_not_contains() {
    local file="$1"
    local needle="$2"
    if grep -Fq -- "$needle" "$file"; then
        echo "--- $file ---" >&2
        cat "$file" >&2
        echo "------------" >&2
        fail "expected not to find: $needle"
    fi
}

assert_not_exists() {
    local path="$1"
    if [ -e "$path" ] || [ -L "$path" ]; then
        fail "expected path to be absent: $path"
    fi
}

assert_log_contains() {
    assert_contains "$LOG_FILE" "$1"
}

assert_log_not_contains() {
    assert_not_contains "$LOG_FILE" "$1"
}

assert_log_count() {
    local expected="$1"
    local pattern="$2"
    local count
    count="$(grep -Fc "$pattern" "$LOG_FILE" || true)"
    if [ "$count" -ne "$expected" ]; then
        echo "--- $LOG_FILE ---" >&2
        cat "$LOG_FILE" >&2
        echo "---------------" >&2
        fail "expected $expected log entries matching '$pattern', got $count"
    fi
}

list_spec_names() {
    python3 - "$GLOBAL_SPECS_FILE" <<'PY'
from pathlib import Path
import sys

for line in Path(sys.argv[1]).read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    print(line.rsplit("@", 1)[1])
PY
}

count_spec_repos() {
    python3 - "$GLOBAL_SPECS_FILE" <<'PY'
from pathlib import Path
import sys

repos = set()
for line in Path(sys.argv[1]).read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    repos.add(line.rsplit("@", 1)[0])

print(len(repos))
PY
}

create_mock_skill_file() {
    local repo_root="$1"
    local skill_name="$2"
    local skill_dir="$repo_root/skills/$skill_name"

    mkdir -p "$skill_dir"
    cat > "$skill_dir/SKILL.md" <<EOF
---
name: $skill_name
description: Mock skill for $skill_name
---
EOF
}

seed_default_mock_repos() {
    local agent_browser_root="$MOCK_REPOS/vercel-labs/agent-browser"

    mkdir -p "$agent_browser_root"

    create_mock_skill_file "$agent_browser_root" "agent-browser"
    create_mock_skill_file "$agent_browser_root" "agentcore"
    create_mock_skill_file "$agent_browser_root" "dogfood"
    create_mock_skill_file "$agent_browser_root" "electron"
    create_mock_skill_file "$agent_browser_root" "slack"
    create_mock_skill_file "$agent_browser_root" "vercel-sandbox"
}

write_fake_skills_cli() {
    cat > "$TEST_ROOT/bin/skills" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

state_file="${FAKE_SKILLS_STATE_FILE:?}"
log_file="${FAKE_SKILLS_LOG_FILE:?}"

touch "$state_file" "$log_file"

dedupe_state() {
    sort -u "$state_file" -o "$state_file"
}

cmd="${1:-}"
shift || true

case "$cmd" in
    list|ls)
        global=0
        json=0
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -g|--global)
                    global=1
                    ;;
                --json)
                    json=1
                    ;;
            esac
            shift
        done
        if [ "$global" -ne 1 ] || [ "$json" -ne 1 ]; then
            echo "unsupported skills list invocation" >&2
            exit 1
        fi
        python3 - "$state_file" "$HOME" <<'PY'
import json
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
home = sys.argv[2]
names = [line.strip() for line in state_path.read_text().splitlines() if line.strip()]
payload = [
    {
        "name": name,
        "path": f"{home}/.agents/skills/{name}",
        "scope": "global",
        "agents": ["Codex"],
    }
    for name in names
]
print(json.dumps(payload))
PY
        ;;
    update)
        echo "mock update"
        ;;
    remove)
        name=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -g|--global|-y|--yes)
                    shift
                    ;;
                *)
                    name="$1"
                    shift
                    ;;
            esac
        done
        if [ -z "$name" ]; then
            echo "missing skill name for remove" >&2
            exit 1
        fi
        printf 'remove|%s\n' "$name" >> "$log_file"
        grep -Fvx "$name" "$state_file" > "$state_file.tmp" || true
        mv "$state_file.tmp" "$state_file"
        ;;
    add)
        repo="${1:-}"
        shift || true
        if [ -z "$repo" ]; then
            echo "missing repo for add" >&2
            exit 1
        fi
        skills=()
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -g|--global|-y|--yes)
                    shift
                    ;;
                -a|--agent)
                    shift
                    while [ "$#" -gt 0 ] && [[ "$1" != -* ]]; do
                        shift
                    done
                    ;;
                -s|--skill)
                    shift
                    while [ "$#" -gt 0 ] && [[ "$1" != -* ]]; do
                        skills+=("$1")
                        shift
                    done
                    ;;
                *)
                    shift
                    ;;
            esac
        done
        if [ "${#skills[@]}" -eq 0 ]; then
            echo "missing skill list for add" >&2
            exit 1
        fi
        printf 'add|%s|%s\n' "$repo" "${skills[*]}" >> "$log_file"
        for skill in "${skills[@]}"; do
            printf '%s\n' "$skill" >> "$state_file"
        done
        dedupe_state
        ;;
    *)
        echo "unsupported fake skills command: $cmd" >&2
        exit 1
        ;;
esac
EOF

    chmod +x "$TEST_ROOT/bin/skills"
}

write_fake_git_cli() {
    cat > "$TEST_ROOT/bin/git" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

log_file="${FAKE_GIT_LOG_FILE:?}"
mock_root="${FAKE_GIT_ROOT:?}"
fail_repos=" ${FAKE_GIT_FAIL_REPOS:-} "

printf 'git|%s\n' "$*" >> "$log_file"

if [ "${1:-}" != "clone" ]; then
    echo "unsupported fake git command" >&2
    exit 1
fi

shift
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
    if [ "$1" = "--depth" ]; then
        shift 2
    else
        shift
    fi
done

url="${1:-}"
dest="${2:-}"
if [ -z "$url" ] || [ -z "$dest" ]; then
    echo "unsupported fake git clone invocation" >&2
    exit 1
fi

repo="${url#https://github.com/}"
repo="${repo%.git}"

if [[ "$fail_repos" == *" $repo "* ]]; then
    exit 1
fi

src="$mock_root/$repo"
if [ ! -d "$src" ]; then
    echo "missing fake git repo: $repo" >&2
    exit 1
fi

mkdir -p "$dest"
cp -R "$src"/. "$dest"/
EOF

    chmod +x "$TEST_ROOT/bin/git"
}

setup_test_env() {
    TEST_ROOT="$(mktemp -d)"
    HOME="$TEST_ROOT/home"
    LOG_FILE="$TEST_ROOT/skills.log"
    GIT_LOG_FILE="$TEST_ROOT/git.log"
    STATE_FILE="$TEST_ROOT/skills-state.txt"
    OUTPUT_FILE="$TEST_ROOT/output.txt"
    MOCK_REPOS="$TEST_ROOT/mock-repos"

    export HOME
    export PATH="$TEST_ROOT/bin:$ORIGINAL_PATH"
    export FAKE_SKILLS_STATE_FILE="$STATE_FILE"
    export FAKE_SKILLS_LOG_FILE="$LOG_FILE"
    export FAKE_GIT_LOG_FILE="$GIT_LOG_FILE"
    export FAKE_GIT_ROOT="$MOCK_REPOS"
    export FAKE_GIT_FAIL_REPOS=""

    mkdir -p "$HOME" "$TEST_ROOT/bin" "$MOCK_REPOS"
    : > "$STATE_FILE"
    : > "$LOG_FILE"
    : > "$GIT_LOG_FILE"

    cp "$MANIFEST_TEMPLATE" "$TEST_ROOT/upstream-coverage.json"
    write_fake_skills_cli
    write_fake_git_cli
    seed_default_mock_repos
}

cleanup_test_env() {
    unset FAKE_GIT_FAIL_REPOS
    rm -rf "$TEST_ROOT"
}

run_sync() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        UPSTREAM_COVERAGE_FILE="$TEST_ROOT/upstream-coverage.json" \
        "$INSTALL_SCRIPT"
    ) > "$OUTPUT_FILE" 2>&1
}

seed_state_with_all_specs() {
    list_spec_names | sort -u > "$STATE_FILE"
}

run_test() {
    local test_name="$1"
    shift

    echo "TEST: $test_name"
    setup_test_env
    if ! "$@"; then
        cleanup_test_env
        fail "$test_name"
    fi
    cleanup_test_env
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "PASS: $test_name"
}

test_clean_noop() {
    seed_state_with_all_specs
    run_sync

    assert_contains "$OUTPUT_FILE" "No stale skills to remove."
    assert_contains "$OUTPUT_FILE" "No upstream coverage drift found."
    assert_contains "$OUTPUT_FILE" "No skills to add."
}

test_stale_removal_and_broken_symlinks() {
    seed_state_with_all_specs
    printf '%s\n' "rogue-skill" >> "$STATE_FILE"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
    ln -s "$TEST_ROOT/does-not-exist" "$HOME/.agents/skills/broken-link"
    ln -s "$TEST_ROOT/does-not-exist" "$HOME/.claude/skills/broken-link"

    run_sync

    assert_contains "$OUTPUT_FILE" "Removing: rogue-skill"
    assert_log_contains "remove|rogue-skill"
    assert_not_exists "$HOME/.agents/skills/broken-link"
    assert_not_exists "$HOME/.claude/skills/broken-link"
}

test_drift_warning_nonfatal() {
    seed_state_with_all_specs
    create_mock_skill_file "$MOCK_REPOS/vercel-labs/agent-browser" "newly-added-skill"

    run_sync

    assert_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in vercel-labs/agent-browser: newly-added-skill"
    assert_contains "$OUTPUT_FILE" "Adding skills..."
    assert_contains "$OUTPUT_FILE" "No skills to add."
    assert_contains "$OUTPUT_FILE" "Done."
}

test_audit_clone_failure_nonfatal() {
    seed_state_with_all_specs
    export FAKE_GIT_FAIL_REPOS="vercel-labs/agent-browser"

    run_sync

    assert_contains "$OUTPUT_FILE" "WARN: Skipping upstream repo coverage audit for vercel-labs/agent-browser"
    assert_contains "$OUTPUT_FILE" "Done."
}

test_layout_drift_warning_nonfatal() {
    seed_state_with_all_specs
    rm -rf "$MOCK_REPOS/vercel-labs/agent-browser/skills"

    run_sync

    assert_contains "$OUTPUT_FILE" "WARN: No skills/*/SKILL.md files found in vercel-labs/agent-browser; repo layout may have changed"
    assert_contains "$OUTPUT_FILE" "WARN: Skipping upstream repo coverage audit for vercel-labs/agent-browser"
    assert_contains "$OUTPUT_FILE" "Done."
}

test_batched_adds() {
    run_sync

    assert_log_count "$(count_spec_repos)" "add|"
    assert_log_count 1 "add|vercel-labs/agent-browser|"
    assert_log_contains "add|vercel-labs/agent-browser|agent-browser agentcore dogfood electron slack vercel-sandbox"
    assert_log_contains "add|openai/skills|openai-docs pdf screenshot security-best-practices skill-creator spreadsheet"
    assert_log_not_contains "add|expo/skills|"
    assert_log_not_contains "add|waynesutton/convexskills|"
}

test_invalid_global_spec_fails_fast() {
    local bad_specs_file="$TEST_ROOT/bad-global-specs.txt"
    cat > "$bad_specs_file" <<'EOF'
openai
EOF

    if (
        cd "$REPO_DIR"
        GLOBAL_SPECS_FILE="$bad_specs_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        UPSTREAM_COVERAGE_FILE="$TEST_ROOT/upstream-coverage.json" \
        "$INSTALL_SCRIPT"
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected install script to reject malformed global specs"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid skill spec in $bad_specs_file:1: openai"
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|"
}

test_repo_wide_global_spec_expands_to_all_skills() {
    local wide_specs_file="$TEST_ROOT/wide-global-specs.txt"
    cat > "$wide_specs_file" <<'EOF'
vercel-labs/agent-browser
EOF

    run_sync_with_env GLOBAL_SPECS_FILE="$wide_specs_file"

    assert_contains "$OUTPUT_FILE" "No stale skills to remove."
    assert_log_count 1 "add|vercel-labs/agent-browser|"
    assert_log_contains "add|vercel-labs/agent-browser|agent-browser agentcore dogfood electron slack vercel-sandbox"
}

test_local_global_specs_are_preserved() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "globalSpecs": [
    "expo/skills@building-native-ui"
  ]
}
EOF

    seed_state_with_all_specs
    printf '%s\n' "building-native-ui" >> "$STATE_FILE"

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_not_contains "$OUTPUT_FILE" "Removing: building-native-ui"
    assert_log_not_contains "remove|building-native-ui"
    assert_log_not_contains "add|expo/skills|"
}

run_sync_with_env() {
    (
        cd "$REPO_DIR"
        env \
            SKILLS_BIN="$TEST_ROOT/bin/skills" \
            UPSTREAM_COVERAGE_FILE="$TEST_ROOT/upstream-coverage.json" \
            "$@" \
            "$INSTALL_SCRIPT"
    ) > "$OUTPUT_FILE" 2>&1
}

run_test "clean noop" test_clean_noop
run_test "stale removal and broken symlinks" test_stale_removal_and_broken_symlinks
run_test "drift warning is non-fatal" test_drift_warning_nonfatal
run_test "audit clone failure is non-fatal" test_audit_clone_failure_nonfatal
run_test "layout drift warning is non-fatal" test_layout_drift_warning_nonfatal
run_test "batched adds by repo" test_batched_adds
run_test "invalid global spec fails fast" test_invalid_global_spec_fails_fast
run_test "repo-wide global spec expands to all skills" test_repo_wide_global_spec_expands_to_all_skills
run_test "local global specs are preserved" test_local_global_specs_are_preserved

echo "PASSED: $TESTS_RUN test(s)"
