#!/usr/bin/env bash
# Команда kabinet: обслуживание сервера кабинета.
ENVF=/etc/kabinet/env
SITE=/opt/kabinet/site
DATA=/var/lib/kabinet
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
run() { sudo -u kabinet env $(grep -v '^#' "$ENVF" | xargs) "$@"; }
case "${1:-}" in
  status)
    for s in kabinet caddy coturn kabinet-update.timer; do printf '%-22s %s\n' "$s" "$(systemctl is-active $s)"; done
    printf 'сервер:                %s\n' "$(curl -fsS --max-time 5 http://127.0.0.1:8080/api/health || echo 'не отвечает')"
    printf 'сайт из GitHub:        %s\n' "$(git -C $SITE log -1 --format='%h %cd' --date=format:'%d.%m %H:%M' 2>/dev/null)"
    printf 'место на диске:        %s свободно\n' "$(df -h / | awk 'NR==2{print $4}')"
    echo 'последние копии базы:'; ls -1t "$DATA/backups" 2>/dev/null | head -3 | sed 's/^/  /' ;;
  passwd)
    read -r -s -p "Новый пароль (от 8 символов): " P1; echo
    read -r -s -p "Ещё раз: " P2; echo
    [ "$P1" = "$P2" ] || { echo "Пароли не совпали"; exit 1; }
    run KAB_NEW_PASS="$P1" node "$SITE/server/kabinet.js" passwd ;;
  backup) run node "$SITE/server/kabinet.js" backup ;;
  backups) ls -lh "$DATA/backups" ;;
  restore)
    f="${2:-}"; [ -n "$f" ] || { echo "Укажите файл: kabinet restore kabinet-2026-11-25.db (список: kabinet backups)"; exit 1; }
    [ -f "$f" ] || f="$DATA/backups/$f"; [ -f "$f" ] || { echo "Нет такого файла"; exit 1; }
    read -r -p "Заменить текущую базу копией $(basename "$f")? Текущая сохранится рядом. (да/нет): " a; [ "$a" = "да" ] || exit 1
    systemctl stop kabinet
    ts=$(date +%Y%m%d-%H%M%S)
    for x in kabinet.db kabinet.db-wal kabinet.db-shm; do [ -f "$DATA/$x" ] && mv "$DATA/$x" "$DATA/$x.before-$ts"; done
    cp "$f" "$DATA/kabinet.db"; chown kabinet:kabinet "$DATA/kabinet.db"
    systemctl start kabinet; echo "Готово. Прежняя база: $DATA/kabinet.db.before-$ts" ;;
  logs) journalctl -u kabinet -u kabinet-update -n "${2:-80}" --no-pager ;;
  update) /usr/local/sbin/kabinet-update; git -C "$SITE" log -1 --format='Сейчас на сервере: %h %s (%cd)' ;;
  restart) systemctl restart kabinet caddy coturn && echo "Перезапущено" ;;
  cloudflare)
    read -r -p "Cloudflare Turn Token ID: " ID; read -r -p "Cloudflare API Token: " TK
    sed -i "s#^CF_TURN_KEY_ID=.*#CF_TURN_KEY_ID=$ID#; s#^CF_TURN_KEY_TOKEN=.*#CF_TURN_KEY_TOKEN=$TK#" "$ENVF"
    systemctl restart kabinet && echo "Сохранено. Видео сможет идти через Cloudflare на порту 443." ;;
  *)
    cat <<H
kabinet status      состояние сервера
kabinet passwd      сменить пароль входа в кабинет
kabinet backup      сделать копию базы сейчас
kabinet backups     список копий
kabinet restore Ф   вернуть базу из копии Ф
kabinet logs        последние записи журнала
kabinet update      подтянуть сайт из GitHub сейчас
kabinet restart     перезапустить всё
kabinet cloudflare  подключить TURN от Cloudflare (для очень закрытых сетей)
H
  ;;
esac
