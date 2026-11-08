#!/bin/sh
# ci-same-tree.sh: answer whether a green run already tested HEAD's tree, so
# main pushes skip pure re-verification (same lookup as blockfield-mod
# release.yml). Prints "true" or "false". Only runs whose CI actually
# executed count: gate-skipped review runs (denied or still awaiting the bot
# verdict) complete "successful" with the check job skipped, so their trees
# must NOT dedupe.
set -eu
workflow="${1:?usage: ci-same-tree.sh <workflow-file>}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
tree=$(git rev-parse 'HEAD^{tree}')
tested=false
# Main-timeline pushes always execute the check job, so a matching tree is
# tested. Review/dispatch runs are deliberately excluded here even when
# successful: without the bot's permit their check never ran.
for sha in $(gh api "repos/${repo}/actions/workflows/${workflow}/runs?status=success&per_page=30" --jq '.workflow_runs[] | select(.event == "push") | .head_sha'); do
    t=$(gh api "repos/${repo}/git/commits/${sha}" --jq '.tree.sha')
    if [ "$t" = "$tree" ]; then tested=true; break; fi
done
# tested-tree-<tree> artifacts are uploaded only by runs whose check fully
# passed (the record steps run only after green checks), on any event shape.
# branch=next keeps the small lookup window on the release-PR runs: review
# runs of feature PRs (head = feature branch) can never match a main push,
# and their successful all-skipped runs must not crowd out the release run.
if [ "$tested" != true ]; then
    for id in $(gh api "repos/${repo}/actions/workflows/${workflow}/runs?status=success&per_page=20&branch=next" --jq '.workflow_runs[].id' || true); do
        if gh api "repos/${repo}/actions/runs/${id}/artifacts?per_page=100" --jq '.artifacts[].name' 2>/dev/null | grep -qx "tested-tree-${tree}"; then tested=true; break; fi
    done
fi
echo "Same tree ${tree} already tested: ${tested}." >&2
echo "$tested"
