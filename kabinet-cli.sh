#!/usr/bin/env bash
# Команда kabinet: обслуживание сервера кабинета.
ENVF=/etc/kabinet/env
SITE=/opt/kabinet/site
DATA=/var/lib/kabinet
JS="$SITE/server/kabinet.js"; [ -f "$JS" ] || JS="$SITE/kabinet.js"
SK="$(dirname "$JS")/shkolkovo.js"
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
    run KAB_NEW_PASS="$P1" node "$JS" passwd ;;
  backup) run node "$JS" backup ;;
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
  shkolkovo)
    shift
    case "${1:-}" in
      log|status) journalctl -u kabinet-shkolkovo -n "${2:-30}" --no-pager -o cat ;;
      stop) systemctl stop kabinet-shkolkovo && echo "Остановлено. Запустите снова — продолжит с того же места." ;;
      reset) read -r -p "Стереть скачанное из Школково и начать заново? (да/нет): " a; [ "$a" = "да" ] || exit 1; rm -rf "$DATA/shkolkovo/raw" "$DATA/shkolkovo/param.json"; echo "Стёрто." ;;
      *)
        [ -f "$SK" ] || { echo "Нет файла shkolkovo.js рядом с kabinet.js — загрузите его в репозиторий"; exit 1; }
        systemctl is-active -q kabinet-shkolkovo && { echo "Уже идёт. Ход: kabinet shkolkovo log"; exit 0; }
        systemctl reset-failed kabinet-shkolkovo 2>/dev/null
        systemd-run -q --unit=kabinet-shkolkovo --uid=kabinet --gid=kabinet --property=EnvironmentFile=$ENVF --setenv=KAB_DATA="$DATA" /usr/bin/node "$SK" "$@" \
          && echo "Загрузка из Школково началась в фоне (займёт несколько часов, можно закрыть терминал)." \
          && echo "Ход:  kabinet shkolkovo log     Остановить:  kabinet shkolkovo stop" ;;
    esac ;;
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
kabinet shkolkovo   скачать каталог задач Школково в готовую базу (log / stop / reset)
H
  ;;
esac
