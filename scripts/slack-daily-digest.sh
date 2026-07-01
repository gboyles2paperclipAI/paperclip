#!/usr/bin/env bash
set -euo pipefail

DATE="${1:-$(date -u +%Y-%m-%d)}"
BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
CHANNEL_ID="${SLACK_ALERTS_CHANNEL_ID:-}"
RESPONSE_FILE="$(mktemp "${TMPDIR:-/tmp}/paperclip-slack-digest-response.XXXXXX.json")"
trap 'rm -f "$RESPONSE_FILE"' EXIT

if [[ -z "$BOT_TOKEN" || -z "$CHANNEL_ID" ]]; then
  echo "Error: SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL_ID are required" >&2
  echo "Usage: SLACK_BOT_TOKEN=xoxb-... SLACK_ALERTS_CHANNEL_ID=C... $0 [date]" >&2
  exit 1
fi

SINCE="${DATE}T00:00:00Z"
UNTIL="$(date -u -d "${DATE} +1 day" +%Y-%m-%d)T00:00:00Z"
COMMIT_COUNT="$(git log --since="$SINCE" --until="$UNTIL" --pretty=format:%H | wc -l | tr -d ' ')"
SUMMARY="$(git log --since="$SINCE" --until="$UNTIL" --pretty=format:'- %s (%h)' | sed -n '1,30p')"

if [[ -z "$SUMMARY" ]]; then
  SUMMARY="- No commits recorded."
fi

PAYLOAD="$(DATE="$DATE" COMMIT_COUNT="$COMMIT_COUNT" SUMMARY="$SUMMARY" CHANNEL_ID="$CHANNEL_ID" node -e '
const payload = {
  channel: process.env.CHANNEL_ID,
  text: `Daily Paperclip digest for ${process.env.DATE}`,
  unfurl_links: false,
  unfurl_media: false,
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*Daily digest* ${process.env.DATE}\\nCommits: ${process.env.COMMIT_COUNT}` } },
    { type: "section", text: { type: "mrkdwn", text: process.env.SUMMARY } }
  ]
};
process.stdout.write(JSON.stringify(payload));
' )"

RESPONSE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer ${BOT_TOKEN}" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data "$PAYLOAD")"

if [[ "$RESPONSE" == "200" ]] && grep -q '"ok":true' "$RESPONSE_FILE"; then
  echo "Slack digest posted for ${DATE} (${COMMIT_COUNT:-0} commits)"
else
  echo "Error: Slack API returned HTTP ${RESPONSE}" >&2
  exit 1
fi
