#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LINK_SCRIPT="$REPO_DIR/link-skills.sh"
TESTS_RUN=0

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_not_exists() {
    local path="$1"
    if [ -e "$path" ] || [ -L "$path" ]; then
        fail "expected path to be absent: $path"
    fi
}

assert_symlink_target() {
    local path="$1"
    local expected="$2"
    if [ ! -L "$path" ]; then
        fail "expected symlink: $path"
    fi

    local actual
    actual="$(readlink "$path")"
    if [ "$actual" != "$expected" ]; then
        fail "expected $path -> $expected, got $actual"
    fi
}

assert_contains() {
    local file="$1"
    local needle="$2"
    if ! grep -Fq "$needle" "$file"; then
        echo "--- $file ---" >&2
        cat "$file" >&2
        echo "------------" >&2
        fail "expected to find: $needle"
    fi
}

setup_test_env() {
    TEST_ROOT="$(mktemp -d)"
    HOME="$TEST_ROOT/home"
    FIXTURE_REPO="$TEST_ROOT/repo"
    OUTPUT_FILE="$TEST_ROOT/output.txt"

    export HOME

    mkdir -p "$HOME" "$FIXTURE_REPO/skills"
    cp "$LINK_SCRIPT" "$FIXTURE_REPO/link-skills.sh"
    chmod +x "$FIXTURE_REPO/link-skills.sh"
}

cleanup_test_env() {
    rm -rf "$TEST_ROOT"
}

create_skill_dir() {
    mkdir -p "$FIXTURE_REPO/skills/$1"
}

run_link() {
    (
        cd "$FIXTURE_REPO"
        ./link-skills.sh
    ) > "$OUTPUT_FILE" 2>&1
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

test_removes_stale_local_symlinks() {
    local target
    create_skill_dir "agents-md"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" "$TEST_ROOT/external"

    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.agents/skills/plan-reviewer"
    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.claude/skills/plan-reviewer"
    ln -s "$TEST_ROOT/external" "$HOME/.agents/skills/external-skill"

    run_link

    for target in "$HOME/.agents/skills/agents-md" "$HOME/.claude/skills/agents-md"; do
        assert_symlink_target "$target" "$FIXTURE_REPO/skills/agents-md/"
    done
    assert_not_exists "$HOME/.agents/skills/plan-reviewer"
    assert_not_exists "$HOME/.claude/skills/plan-reviewer"
    assert_symlink_target "$HOME/.agents/skills/external-skill" "$TEST_ROOT/external"
    assert_contains "$OUTPUT_FILE" "Removing stale local link: plan-reviewer from $HOME/.agents/skills"
    assert_contains "$OUTPUT_FILE" "Removing stale local link: plan-reviewer from $HOME/.claude/skills"
}

test_empty_skills_dir_cleans_without_creating_bogus_links() {
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.agents/skills/plan-reviewer"
    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.claude/skills/plan-reviewer"

    run_link

    assert_not_exists "$HOME/.agents/skills/plan-reviewer"
    assert_not_exists "$HOME/.claude/skills/plan-reviewer"
}

run_test "removes stale local symlinks" test_removes_stale_local_symlinks
run_test "empty skills dir cleans without bogus links" test_empty_skills_dir_cleans_without_creating_bogus_links

echo "PASSED: $TESTS_RUN test(s)"
