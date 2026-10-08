#!/usr/bin/env bash
# The operator's moderation tool for public content (ADR 0097,
# docs/public-content-rules.md). It never goes through HTTP: it runs the
# service binary against the database, inside the deployed stack.
#
#   scripts/takedown.sh --directory <private dir> reports
#       Open reports, oldest first, one JSON object per line.
#   scripts/takedown.sh --directory <private dir> page <slug> "<reason>"
#   scripts/takedown.sh --directory <private dir> site <site id> "<reason>"
#   scripts/takedown.sh --directory <private dir> profile <handle> "<reason>"
#   scripts/takedown.sh --directory <private dir> assistant <listing id> "<reason>"
#       Hide it at once, count it against its owner (three takedowns suspend
#       publishing) and refuse an identical copy from then on.
#   scripts/takedown.sh --directory <private dir> dismiss <kind> <target id>
#       Close the reports on a target without taking it down.
#
# <private dir> is the stack's private directory, the one stack.py takes.
# Without --directory the tool runs the local build with ./config.toml.
set -euo pipefail
cd "$(dirname "$0")/.."

run=(cargo run --quiet -p subrosa-cloud --)
if [[ "${1:-}" == "--directory" ]]; then
    directory="$(cd "${2:?the private directory}" && pwd)"
    shift 2
    run=(docker compose --env-file "$directory/stack.env" -f deploy/vps/compose.yaml run --rm --no-deps api)
fi

usage() {
    sed -n '2,19p' "$0" >&2
    exit 2
}

case "${1:-}" in
    reports)
        "${run[@]}" reports
        ;;
    page | site | profile | assistant)
        [[ $# -eq 3 && -n "$3" ]] || usage
        "${run[@]}" takedown "$1" "$2" --reason "$3"
        ;;
    dismiss)
        [[ $# -eq 3 ]] || usage
        "${run[@]}" dismiss "$2" "$3"
        ;;
    *)
        usage
        ;;
esac
