#!/usr/bin/env bash
# Кабинет: подтягивает сайт из GitHub. Запускается таймером каждые 2 минуты.
set -uo pipefail
SITE=/opt/kabinet/site
cd "$SITE" || exit 0
old=$(git rev-parse HEAD 2>/dev/null) || exit 0
timeout 90 git fetch -q origin 2>/dev/null || exit 0
br=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || true)
[ -n "$br" ] && [ "$br" != "origin/HEAD" ] || br=origin/$(git rev-parse --abbrev-ref HEAD)
git reset -q --hard "$br" || exit 0
new=$(git rev-parse HEAD)
[ "$old" = "$new" ] && exit 0
chmod -R a+rX "$SITE"
changed=$(git diff --name-only "$old" "$new" 2>/dev/null || echo server/kabinet.js)
if printf '%s\n' "$changed" | grep -Eq '^(server/)?kabinet\.js$'; then systemctl restart kabinet; fi
for f in server/kabinet-cli.sh kabinet-cli.sh; do
  if printf '%s\n' "$changed" | grep -qx "$f"; then install -m 0755 "$f" /usr/local/bin/kabinet; fi
done
logger -t kabinet "сайт обновлён до ${new:0:7}"
