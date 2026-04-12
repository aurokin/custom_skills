#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SCRIPT="$REPO_DIR/deploy-project-skills.sh"
FAMILY_MANIFEST_TEMPLATE="$REPO_DIR/catalog/family-coverage.json"
ORIGINAL_PATH="$PATH"
SYSTEM_GIT="$(command -v git)"
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

assert_log_contains() {
    assert_contains "$LOG_FILE" "$1"
}

assert_log_not_contains() {
    assert_not_contains "$LOG_FILE" "$1"
}

assert_git_log_not_contains() {
    assert_not_contains "$GIT_LOG_FILE" "$1"
}

write_fake_skills_cli() {
    cat > "$TEST_ROOT/bin/skills" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

log_file="${FAKE_SKILLS_LOG_FILE:?}"
cmd="${1:-}"
shift || true

join_by_space() {
    local first=1
    local item
    for item in "$@"; do
        if [ "$first" -eq 1 ]; then
            printf '%s' "$item"
            first=0
        else
            printf ' %s' "$item"
        fi
    done
}

case "$cmd" in
    add)
        repo="${1:-}"
        shift || true
        agents=()
        skills=()
        copy_mode=0
        yes_mode=0
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --copy)
                    copy_mode=1
                    shift
                    ;;
                -y|--yes)
                    yes_mode=1
                    shift
                    ;;
                -a|--agent)
                    shift
                    while [ "$#" -gt 0 ] && [[ "$1" != -* ]]; do
                        agents+=("$1")
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

        printf 'pwd|%s\n' "$PWD" >> "$log_file"
        if [ "${#skills[@]}" -eq 0 ]; then
            skills=("<all>")
        fi

        printf 'add|%s|agents=%s|skills=%s|copy=%s|yes=%s\n' \
            "$repo" \
            "$(join_by_space "${agents[@]}")" \
            "$(join_by_space "${skills[@]}")" \
            "$copy_mode" \
            "$yes_mode" >> "$log_file"
        ;;
    *)
        echo "unsupported fake skills command: $cmd" >&2
        exit 1
        ;;
esac
EOF

    chmod +x "$TEST_ROOT/bin/skills"
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
    local expo_root="$MOCK_REPOS/expo/skills"
    local convex_root="$MOCK_REPOS/waynesutton/convexskills"

    mkdir -p "$expo_root" "$convex_root"

    create_mock_skill_file "$expo_root" "building-native-ui"
    create_mock_skill_file "$expo_root" "expo-api-routes"
    create_mock_skill_file "$expo_root" "expo-cicd-workflows"
    create_mock_skill_file "$expo_root" "expo-deployment"
    create_mock_skill_file "$expo_root" "expo-dev-client"
    create_mock_skill_file "$expo_root" "expo-tailwind-setup"
    create_mock_skill_file "$expo_root" "native-data-fetching"
    create_mock_skill_file "$expo_root" "upgrading-expo"
    create_mock_skill_file "$expo_root" "use-dom"

    create_mock_skill_file "$convex_root" "avoid-feature-creep"
    create_mock_skill_file "$convex_root" "convex"
    create_mock_skill_file "$convex_root" "convex-agents"
    create_mock_skill_file "$convex_root" "convex-best-practices"
    create_mock_skill_file "$convex_root" "convex-component-authoring"
    create_mock_skill_file "$convex_root" "convex-cron-jobs"
    create_mock_skill_file "$convex_root" "convex-file-storage"
    create_mock_skill_file "$convex_root" "convex-functions"
    create_mock_skill_file "$convex_root" "convex-http-actions"
    create_mock_skill_file "$convex_root" "convex-migrations"
    create_mock_skill_file "$convex_root" "convex-realtime"
    create_mock_skill_file "$convex_root" "convex-schema-validator"
    create_mock_skill_file "$convex_root" "convex-security-audit"
    create_mock_skill_file "$convex_root" "convex-security-check"
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
    PROJECT_ROOT="$TEST_ROOT/project"
    NESTED_TARGET="$PROJECT_ROOT/apps/mobile"
    PLAIN_TARGET="$TEST_ROOT/plain-project"
    MOCK_REPOS="$TEST_ROOT/mock-repos"
    LOG_FILE="$TEST_ROOT/skills.log"
    GIT_LOG_FILE="$TEST_ROOT/git.log"
    OUTPUT_FILE="$TEST_ROOT/output.txt"
    FAMILY_MANIFEST_FILE="$TEST_ROOT/family-coverage.json"

    export PATH="$TEST_ROOT/bin:$ORIGINAL_PATH"
    export FAKE_SKILLS_LOG_FILE="$LOG_FILE"
    export FAKE_GIT_LOG_FILE="$GIT_LOG_FILE"
    export FAKE_GIT_ROOT="$MOCK_REPOS"
    export FAKE_GIT_FAIL_REPOS=""

    mkdir -p "$TEST_ROOT/bin" "$NESTED_TARGET" "$PLAIN_TARGET" "$MOCK_REPOS"
    : > "$LOG_FILE"
    : > "$GIT_LOG_FILE"
    cp "$FAMILY_MANIFEST_TEMPLATE" "$FAMILY_MANIFEST_FILE"
    write_fake_skills_cli
    write_fake_git_cli
    seed_default_mock_repos

    "$SYSTEM_GIT" init -q "$PROJECT_ROOT"
}

cleanup_test_env() {
    unset FAKE_GIT_FAIL_REPOS
    rm -rf "$TEST_ROOT"
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

test_list_families() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" $'expo\tExpo and React Native workflow skills'
    assert_contains "$OUTPUT_FILE" $'convex\tConvex platform and data layer skills'
}

test_list_families_skips_missing_spec_files() {
    local bad_catalog="$TEST_ROOT/bad-catalog"
    mkdir -p "$bad_catalog/families"
    cat > "$bad_catalog/families.tsv" <<'EOF'
expo	Expo and React Native workflow skills
ghost	Ghost family
EOF
    cat > "$bad_catalog/families/expo.txt" <<'EOF'
expo/skills@building-native-ui
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$bad_catalog" \
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" $'expo\tExpo and React Native workflow skills'
    assert_not_contains "$OUTPUT_FILE" "ghost"
}

test_list_families_skips_malformed_spec_files() {
    local bad_catalog="$TEST_ROOT/bad-catalog"
    mkdir -p "$bad_catalog/families"
    cat > "$bad_catalog/families.tsv" <<'EOF'
expo	Expo and React Native workflow skills
broken	Broken family
EOF
    cat > "$bad_catalog/families/expo.txt" <<'EOF'
expo/skills@building-native-ui
EOF
    cat > "$bad_catalog/families/broken.txt" <<'EOF'
bad spec
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$bad_catalog" \
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" $'expo\tExpo and React Native workflow skills'
    assert_not_contains "$OUTPUT_FILE" "broken"
}

test_help_without_dependencies() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --help
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Usage: ./deploy-project-skills.sh [options]"
    assert_contains "$OUTPUT_FILE" "--list-families"
}

test_missing_flag_values_fail_fast() {
    if (
        cd "$REPO_DIR"
        "$DEPLOY_SCRIPT" --target --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected --target without a value to fail"
    fi
    assert_contains "$OUTPUT_FILE" "Missing value for --target"

    if (
        cd "$REPO_DIR"
        "$DEPLOY_SCRIPT" --family --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected --family without a value to fail"
    fi
    assert_contains "$OUTPUT_FILE" "Missing value for --family"

    if (
        cd "$REPO_DIR"
        "$DEPLOY_SCRIPT" --agents --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected --agents without a value to fail"
    fi
    assert_contains "$OUTPUT_FILE" "Missing value for --agents"
}

test_noninteractive_deploy() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$NESTED_TARGET" \
            --family expo \
            --family convex \
            --agents "codex claude-code" \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $NESTED_TARGET"
    assert_contains "$OUTPUT_FILE" "Families: expo convex"
    assert_log_contains "pwd|$NESTED_TARGET"
    assert_log_contains "add|expo/skills|agents=codex claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_contains "add|waynesutton/convexskills|agents=codex claude-code|skills=convex convex-agents convex-best-practices convex-component-authoring convex-cron-jobs convex-file-storage convex-functions convex-http-actions convex-migrations convex-realtime convex-schema-validator convex-security-audit convex-security-check|copy=1|yes=1"
}

test_noninteractive_deploy_non_git_target() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $PLAIN_TARGET"
    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "pwd|$PLAIN_TARGET"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_not_contains "add|waynesutton/convexskills|"
}

test_interactive_deploy() {
    (
        cd "$REPO_DIR"
        printf '%s\n\nexpo\ny\n' "$PROJECT_ROOT" | \
            SKILLS_BIN="$TEST_ROOT/bin/skills" \
            SKILLS_AUDIT_REPO_COVERAGE=0 \
            "$DEPLOY_SCRIPT" --interactive
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_not_contains "add|waynesutton/convexskills|"
}

test_all_families_deploy() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --all-families \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo convex"
    assert_log_contains "add|expo/skills|"
    assert_log_contains "add|waynesutton/convexskills|"
}

test_repo_wide_family_spec_installs_all_skills() {
    local wide_catalog="$TEST_ROOT/wide-catalog"
    mkdir -p "$wide_catalog/families"
    cat > "$wide_catalog/families.tsv" <<'EOF'
all-openai	All OpenAI skills
EOF
    cat > "$wide_catalog/families/all-openai.txt" <<'EOF'
openai/skills
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$wide_catalog" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family all-openai \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: all-openai"
    assert_contains "$OUTPUT_FILE" "openai/skills: (all skills)"
    assert_log_contains "add|openai/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=<all>|copy=1|yes=1"
}

test_family_audit_warning_nonfatal() {
    create_mock_skill_file "$MOCK_REPOS/expo/skills" "newly-added-skill"

    (
        cd "$REPO_DIR"
        PATH="$TEST_ROOT/bin:$ORIGINAL_PATH" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        FAMILY_UPSTREAM_COVERAGE_FILE="$FAMILY_MANIFEST_FILE" \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Auditing curated family repos..."
    assert_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in expo/skills: newly-added-skill"
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_contains "add|expo/skills|"
}

test_dry_run_skips_audit_and_install() {
    create_mock_skill_file "$MOCK_REPOS/expo/skills" "newly-added-skill"

    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        FAMILY_UPSTREAM_COVERAGE_FILE="$FAMILY_MANIFEST_FILE" \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --dry-run
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $PLAIN_TARGET"
    assert_contains "$OUTPUT_FILE" "Planned installs:"
    assert_not_contains "$OUTPUT_FILE" "Auditing curated family repos..."
    assert_not_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s)"
    assert_log_not_contains "add|"
    assert_git_log_not_contains "git|clone"
}

test_invalid_catalog_spec_fails_fast() {
    local bad_catalog="$TEST_ROOT/bad-catalog"
    mkdir -p "$bad_catalog/families"
    cat > "$bad_catalog/families.tsv" <<'EOF'
broken	Broken family
EOF
    cat > "$bad_catalog/families/broken.txt" <<'EOF'
bad spec
EOF

    if (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILL_CATALOG_DIR="$bad_catalog" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family broken \
            --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected deploy script to reject malformed catalog specs"
    fi

    assert_contains "$OUTPUT_FILE" "Unknown family: broken"
    assert_log_not_contains "add|"
}

run_test "list families" test_list_families
run_test "list families skips missing spec files" test_list_families_skips_missing_spec_files
run_test "list families skips malformed spec files" test_list_families_skips_malformed_spec_files
run_test "help without dependencies" test_help_without_dependencies
run_test "missing flag values fail fast" test_missing_flag_values_fail_fast
run_test "non-interactive deploy" test_noninteractive_deploy
run_test "non-interactive deploy to non-git target" test_noninteractive_deploy_non_git_target
run_test "interactive deploy" test_interactive_deploy
run_test "all families deploy" test_all_families_deploy
run_test "repo-wide family spec installs all skills" test_repo_wide_family_spec_installs_all_skills
run_test "family audit warning is non-fatal" test_family_audit_warning_nonfatal
run_test "dry run skips audit and install" test_dry_run_skips_audit_and_install
run_test "invalid catalog spec fails fast" test_invalid_catalog_spec_fails_fast

echo "PASSED: $TESTS_RUN test(s)"
