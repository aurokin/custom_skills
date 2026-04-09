#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

# Link all skills from this repository to the shared agents skills dir

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$SCRIPT_DIR/skills"
SKILL_TARGET_DIRS=(
    "$HOME/.agents/skills"
    "$HOME/.claude/skills"
)
SKILL_PATHS=("$SKILLS_DIR"/*/)

declare -A LOCAL_SKILL_NAMES=()
for skill in "${SKILL_PATHS[@]}"; do
    LOCAL_SKILL_NAMES["$(basename "$skill")"]=1
done

# Create skill directories if they don't exist
for target_dir in "${SKILL_TARGET_DIRS[@]}"; do
    mkdir -p "$target_dir"
done

# Remove stale symlinks previously created for repo-local skills that no longer exist.
for target_dir in "${SKILL_TARGET_DIRS[@]}"; do
    while IFS= read -r -d '' target; do
        skill_name="$(basename "$target")"
        link_dest="$(readlink "$target" || true)"

        if [[ "$link_dest" == "$SKILLS_DIR/"* ]] && [[ -z "${LOCAL_SKILL_NAMES[$skill_name]:-}" ]]; then
            echo "Removing stale local link: $skill_name from $target_dir"
            rm "$target"
        fi
    done < <(find "$target_dir" -maxdepth 1 -mindepth 1 -type l -print0)
done

# Link each skill
for skill in "${SKILL_PATHS[@]}"; do
    skill_name="$(basename "$skill")"

    for target_dir in "${SKILL_TARGET_DIRS[@]}"; do
        target="$target_dir/$skill_name"

        if [ -L "$target" ]; then
            echo "Updating link: $skill_name -> $target_dir"
            rm "$target"
        elif [ -e "$target" ]; then
            echo "Skipping $skill_name in $target_dir: already exists and is not a symlink"
            continue
        else
            echo "Linking: $skill_name -> $target_dir"
        fi

        ln -s "$skill" "$target"
    done
done

echo "Done!"
