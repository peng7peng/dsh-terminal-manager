#!/usr/bin/env bash
# Release gate: block production deploys unless a release authorization is
# present. Runs as a hook (reads the tool-input JSON on stdin, as Claude Code
# PreToolUse hooks do) or standalone with the command as the first argument.
# Exit 2 blocks the action and the message is shown to the agent.
set -euo pipefail

cmd="${1:-}"

if [[ -z "$cmd" && ! -t 0 ]]; then
  input="$(cat)"
  if command -v jq >/dev/null 2>&1 && jq -e '.tool_input.command' <<<"$input" >/dev/null 2>&1; then
    cmd="$(jq -r '.tool_input.command' <<<"$input")"
  else
    cmd="$input"
  fi
fi

# Word-boundary match so "undeploy" or "productionize" do not trip the gate.
if [[ "$cmd" =~ (^|[^[:alpha:]])deploy([^[:alpha:]]|$) && "$cmd" =~ (^|[^[:alpha:]])production([^[:alpha:]]|$) ]]; then
  if [[ -z "${RELEASE_APPROVAL:-}" ]]; then
    echo "BLOCK: production deploys need a release authorization." >&2
    echo "An authorized human must set RELEASE_APPROVAL=<ticket-or-signer> or approve via the org's release process (RELEASE_APPROVAL is a stand-in for your approval service)." >&2
    exit 2
  fi
fi

echo "ALLOW"
exit 0
