#!/usr/bin/env bash
# Poll a PR (every 5 seconds by default); merge it (merge commit, delete branch) once it is approved.
# Usage: merge-when-approved.sh [PR_NUMBER] [OWNER/REPO] [INTERVAL_SECONDS]

set -uo pipefail

PR="${1:-932}"
REPO="${2:-edstem-tech/stumped}"
INTERVAL="${3:-5}"

[[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]] || { echo "Interval must be a positive integer (seconds)" >&2; exit 1; }

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }

log "Watching $REPO#$PR every ${INTERVAL}s"

while true; do
  if ! info=$(gh pr view "$PR" --repo "$REPO" --json state,reviewDecision,isDraft \
        --jq '[.state, .reviewDecision, .isDraft] | @tsv' 2>&1); then
    log "gh error: $info"
    sleep "$INTERVAL"
    continue
  fi

  IFS=$'\t' read -r state decision draft <<<"$info"

  case "$state" in
    MERGED) log "PR already merged. Done."; exit 0 ;;
    CLOSED) log "PR is closed without merging. Stopping."; exit 1 ;;
  esac

  if [[ "$decision" == "APPROVED" && "$draft" != "true" ]]; then
    log "Approved. Merging..."
    if out=$(gh pr merge "$PR" --repo "$REPO" --merge --delete-branch 2>&1); then
      log "Merged $REPO#$PR."
      exit 0
    fi
    # e.g. required checks still running or a merge conflict; keep polling
    log "Merge not possible yet: $out"
  else
    log "Not ready (state=$state, review=${decision:-none}, draft=$draft)"
  fi

  sleep "$INTERVAL"
done
