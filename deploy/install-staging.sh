#!/usr/bin/env bash
set -euo pipefail

release_id="20260830-2010"
node_version="v24.20.0"
node_archive="node-${node_version}-linux-x64-glibc-217.tar.xz"
node_base="https://unofficial-builds.nodejs.org/download/release/${node_version}"
release_dir="/opt/enterprise-sso/releases/${release_id}"

for target in /opt/enterprise-sso /opt/node-enterprise-sso /etc/enterprise-sso /var/lib/enterprise-sso /etc/systemd/system/enterprise-sso.service; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Refusing to overwrite existing target: $target" >&2
    exit 2
  fi
done

command -v xz >/dev/null
command -v openssl >/dev/null
id enterprise-sso >/dev/null 2>&1 || useradd --system --home-dir /var/lib/enterprise-sso --shell /sbin/nologin enterprise-sso

curl --fail --location --retry 3 --output "/tmp/${node_archive}" "${node_base}/${node_archive}"
curl --fail --location --retry 3 --output /tmp/node-shasums256.txt "${node_base}/SHASUMS256.txt"
(cd /tmp && grep " ${node_archive}$" node-shasums256.txt | sha256sum --check --strict)
tar -xJf "/tmp/${node_archive}" -C /opt
ln -s "/opt/node-${node_version}-linux-x64-glibc-217" /opt/node-enterprise-sso

install -d -m 0755 /opt/enterprise-sso/releases
install -d -m 0755 "$release_dir"
tar -xzf /tmp/enterprise-sso-release.tgz -C "$release_dir" --strip-components=1
ln -s "$release_dir" /opt/enterprise-sso/current

install -d -o enterprise-sso -g enterprise-sso -m 0700 /var/lib/enterprise-sso
install -d -m 0750 /etc/enterprise-sso
cookie_one="$(openssl rand -base64 48 | tr -d '\n')"
cookie_two="$(openssl rand -base64 48 | tr -d '\n')"
storage_key="$(openssl rand -hex 32)"
password_pepper="$(openssl rand -hex 32)"
install -m 0600 -o root -g enterprise-sso /dev/null /etc/enterprise-sso/enterprise-sso.env
{
  printf '%s\n' 'NODE_ENV=development'
  printf '%s\n' 'HOST=127.0.0.1' 'PORT=3000' 'ISSUER=http://127.0.0.1:3000' 'TRUST_PROXY=loopback'
  printf '%s\n' 'DB_FILE=/var/lib/enterprise-sso/enterprise-sso.sqlite3'
  printf 'COOKIE_KEYS=%s,%s\n' "$cookie_one" "$cookie_two"
  printf '%s\n' 'OIDC_JWKS_FILE=/var/lib/enterprise-sso/jwks.json'
  printf 'OIDC_STORAGE_KEY=%s\n' "$storage_key"
  printf 'PASSWORD_PEPPER=%s\n' "$password_pepper"
  printf '%s\n' 'SSO_IDLE_TTL_SECONDS=7200' 'SSO_ABSOLUTE_TTL_SECONDS=28800' 'AUTH_CODE_TTL_SECONDS=60' 'WE_COM_TRANSACTION_TTL_SECONDS=120'
  printf '%s\n' 'WECOM_CORP_ID=' 'WECOM_AGENT_ID=' 'WECOM_CORP_SECRET=' 'WECOM_OAUTH_SCOPE=snsapi_base'
} > /etc/enterprise-sso/enterprise-sso.env

cd "$release_dir"
/opt/node-enterprise-sso/bin/npm ci --omit=dev --ignore-scripts
chown -R root:root "$release_dir"
chmod -R go-w "$release_dir"

set -a
. /etc/enterprise-sso/enterprise-sso.env
set +a
runuser -u enterprise-sso -- /opt/node-enterprise-sso/bin/npm run migrate

install -m 0644 "$release_dir/deploy/enterprise-sso.service" /etc/systemd/system/enterprise-sso.service
systemctl daemon-reload
systemctl enable --now enterprise-sso.service
sleep 2
curl --fail --silent --show-error http://127.0.0.1:3000/healthz
systemctl --no-pager --full status enterprise-sso.service

rm -f "/tmp/${node_archive}" /tmp/node-shasums256.txt /tmp/enterprise-sso-release.tgz
