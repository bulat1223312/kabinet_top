#!/usr/bin/env bash
# Кабинет репетитора: установка на чистый сервер Ubuntu 24.04 (или 22.04, Debian 12).
# Запуск от root:  bash /opt/kabinet/site/server/install.sh
# Повторный запуск безопасен: он обновит настройки и ничего не сотрёт.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

SITE=/opt/kabinet/site
DATA=/var/lib/kabinet
ETC=/etc/kabinet
PYV=0.26.4

say()  { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }
ask()  { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }

[ "$(id -u)" = 0 ] || die "запустите от root (или через sudo)"
# файлы сервера могут лежать в папке server/ или прямо в корне репозитория
if [ -f "$SITE/server/kabinet.js" ]; then SRV="$SITE/server"; elif [ -f "$SITE/kabinet.js" ]; then SRV="$SITE"; else die "не найден kabinet.js в $SITE. Загрузите файлы сервера на GitHub (см. инструкцию) и выполните: cd $SITE && git pull"; fi
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) die "нужна Ubuntu или Debian, а здесь $PRETTY_NAME";; esac

mkdir -p "$ETC"
[ -f "$ETC/install.conf" ] && . "$ETC/install.conf"

say "Настройки"
DOMAIN=${DOMAIN:-}
while [ -z "$DOMAIN" ]; do DOMAIN=$(ask "Адрес сайта (например bulat-tutor.duckdns.org): "); done
DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##')
EMAIL=${EMAIL:-}
[ -n "$EMAIL" ] || EMAIL=$(ask "Ваша почта (для сертификата https, можно оставить пустым): ")
ok "Адрес: https://$DOMAIN"

say "Проверяю, что адрес указывает на этот сервер"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git dnsutils ufw unattended-upgrades bzip2 sudo >/dev/null
MYIP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || true)
DNSIP=$(dig +short A "$DOMAIN" @1.1.1.1 | tail -n1 || true)
ok "IP сервера: ${MYIP:-не определён}, адрес указывает на: ${DNSIP:-никуда}"
if [ -n "$MYIP" ] && [ "$MYIP" != "$DNSIP" ]; then
  warn "Адрес $DOMAIN пока не указывает на этот сервер ($MYIP)."
  warn "Впишите IP $MYIP на duckdns.org (или у регистратора домена) и подождите пару минут."
  [ "$(ask 'Продолжить всё равно? (да/нет): ')" = "да" ] || exit 1
fi

say "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi
ok "$(node -v)"

say "Caddy (https и сертификаты)"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
ok "$(caddy version | head -n1)"

say "coturn (видео через сложные сети)"
apt-get install -y -qq coturn >/dev/null
ok "установлен"

say "Пользователь и папки"
id kabinet >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin kabinet
install -d -o kabinet -g kabinet -m 0750 "$DATA" "$DATA/backups"
chmod -R a+rX "$SITE"
git config --global --add safe.directory "$SITE" 2>/dev/null || true

if [ ! -f "$ETC/env" ]; then
  TURN_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
  cat > "$ETC/env" <<EOF
KAB_PORT=8080
KAB_HOST=127.0.0.1
KAB_SITE=$SITE
KAB_DATA=$DATA
KAB_TURN_HOST=$DOMAIN
KAB_TURN_PORT=3478
KAB_TURN_SECRET=$TURN_SECRET
KAB_KEEP_BACKUPS=14
# Необязательно: TURN от Cloudflare (порт 443) для сетей, где закрыто всё, кроме сайтов.
CF_TURN_KEY_ID=
CF_TURN_KEY_TOKEN=
EOF
fi
sed -i "s#^KAB_TURN_HOST=.*#KAB_TURN_HOST=$DOMAIN#" "$ETC/env"
chown root:kabinet "$ETC/env"; chmod 0640 "$ETC/env"
. "$ETC/env"
printf 'DOMAIN=%q\nEMAIL=%q\n' "$DOMAIN" "$EMAIL" > "$ETC/install.conf"

say "Python для учеников (Pyodide $PYV) на своём сервере"
if [ ! -f "$DATA/py/pyodide.js" ]; then
  tmp=$(mktemp -d)
  if curl -fsSL --max-time 300 -o "$tmp/py.tar.bz2" "https://github.com/pyodide/pyodide/releases/download/$PYV/pyodide-core-$PYV.tar.bz2"; then
    tar -xjf "$tmp/py.tar.bz2" -C "$tmp" && rm -rf "$DATA/py" && mv "$tmp/pyodide" "$DATA/py" && chown -R kabinet:kabinet "$DATA/py" && ok "скачан"
  else
    warn "не скачался, Python будет грузиться с jsdelivr (тоже работает)"
  fi
  rm -rf "$tmp"
else ok "уже есть"; fi

say "Служба кабинета"
cat > /etc/systemd/system/kabinet.service <<EOF
[Unit]
Description=Kabinet tutor server
After=network-online.target
Wants=network-online.target

[Service]
User=kabinet
Group=kabinet
EnvironmentFile=$ETC/env
ExecStart=/usr/bin/node $SRV/kabinet.js
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=$DATA
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

say "Пароль репетитора"
HAS_PASS=$(sudo -u kabinet env $(grep -v '^#' "$ETC/env" | xargs) node "$SRV/kabinet.js" check | grep -c '"pass":true' || true)
if [ "$HAS_PASS" = "0" ] || [ "${RESET_PASS:-}" = 1 ]; then
  while :; do
    read -r -s -p "Придумайте пароль для входа в кабинет (от 8 символов): " P1 </dev/tty; echo
    read -r -s -p "Ещё раз: " P2 </dev/tty; echo
    [ "$P1" = "$P2" ] && [ ${#P1} -ge 8 ] && break
    warn "Пароли не совпали или короче 8 символов, попробуйте снова"
  done
  sudo -u kabinet env $(grep -v '^#' "$ETC/env" | xargs) KAB_NEW_PASS="$P1" node "$SRV/kabinet.js" passwd
  unset P1 P2
else ok "уже задан (сменить: kabinet passwd)"; fi

systemctl daemon-reload
systemctl enable -q kabinet
systemctl restart kabinet

say "Настройка https"
{
  if [ -n "$EMAIL" ]; then printf '{\n  email %s\n}\n\n' "$EMAIL"; fi
  cat <<EOF
$DOMAIN {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)"
    -Server
  }
  reverse_proxy 127.0.0.1:$KAB_PORT
}
EOF
} > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
systemctl enable -q caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Настройка coturn"
PRIV=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
EXT=""
if [ -n "$MYIP" ] && [ "$MYIP" != "$PRIV" ]; then EXT="external-ip=$MYIP/$PRIV"; fi
cat > /etc/turnserver.conf <<EOF
listening-port=$KAB_TURN_PORT
fingerprint
use-auth-secret
static-auth-secret=$KAB_TURN_SECRET
realm=$DOMAIN
$EXT
min-port=49152
max-port=65535
total-quota=300
user-quota=12
stale-nonce=600
no-multicast-peers
no-cli
no-tls
no-dtls
no-software-attribute
syslog
simple-log
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable -q coturn
systemctl restart coturn

say "Брандмауэр"
ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow "$KAB_TURN_PORT"/tcp >/dev/null
ufw allow "$KAB_TURN_PORT"/udp >/dev/null
ufw allow 49152:65535/udp >/dev/null
ufw --force enable >/dev/null
ok "открыты: 22, 80, 443, $KAB_TURN_PORT, 49152-65535/udp"

say "Автообновление сайта из GitHub и системы"
install -m 0755 "$SRV/update.sh" /usr/local/sbin/kabinet-update
install -m 0755 "$SRV/kabinet-cli.sh" /usr/local/bin/kabinet
cat > /etc/systemd/system/kabinet-update.service <<EOF
[Unit]
Description=Kabinet: pull site from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/kabinet-update
EOF
cat > /etc/systemd/system/kabinet-update.timer <<EOF
[Unit]
Description=Kabinet: pull site from GitHub every 2 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable -q --now kabinet-update.timer
# автоматические обновления безопасности Ubuntu
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
ok "сайт подтягивается с GitHub каждые 2 минуты, обновления безопасности ставятся сами"

say "Проверка"
sleep 3
if curl -fsS --max-time 5 http://127.0.0.1:$KAB_PORT/api/health >/dev/null; then ok "сервер кабинета работает"; else warn "сервер кабинета не отвечает: journalctl -u kabinet -n 50"; fi
systemctl is-active -q coturn && ok "coturn работает" || warn "coturn не запустился: journalctl -u coturn -n 50"
for i in $(seq 1 20); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok "https://$DOMAIN открывается"; HTTPS_OK=1; break; fi
  sleep 3
done
[ "${HTTPS_OK:-}" = 1 ] || warn "https пока не открылся. Обычно это значит, что адрес ещё не указывает на сервер. Подождите 5 минут и откройте сайт; если нет: journalctl -u caddy -n 50"

printf '\n\033[1;32mГотово!\033[0m Откройте https://%s и войдите с паролем.\n' "$DOMAIN"
printf 'Полезные команды: kabinet status | kabinet passwd | kabinet backup | kabinet logs | kabinet update\n\n'
