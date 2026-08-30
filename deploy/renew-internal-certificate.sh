#!/usr/bin/env bash
set -euo pipefail

TLS_DIR=/etc/enterprise-sso/tls
OPENSSL_CNF=/etc/enterprise-sso/internal-ca-openssl.cnf
mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

if [[ ! -f "$TLS_DIR/ca.key" || ! -f "$TLS_DIR/ca.crt" ]]; then
  umask 077
  openssl genrsa -out "$TLS_DIR/ca.key" 4096
  openssl req -x509 -new -sha256 -days 3650 \
    -key "$TLS_DIR/ca.key" \
    -out "$TLS_DIR/ca.crt" \
    -config "$OPENSSL_CNF" \
    -extensions root_ca
fi

if [[ "${FORCE_RENEW:-0}" != "1" ]] && [[ -f "$TLS_DIR/server.crt" ]] && openssl x509 -checkend 2592000 -noout -in "$TLS_DIR/server.crt"; then
  exit 0
fi

WORK_DIR="$(mktemp -d "$TLS_DIR/.renew.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
umask 077

openssl genrsa -out "$WORK_DIR/server.key" 2048
openssl req -new -sha256 \
  -key "$WORK_DIR/server.key" \
  -out "$WORK_DIR/server.csr" \
  -subj "/CN=210.47.163.114/O=Enterprise Internal Services"
openssl x509 -req -sha256 -days 397 \
  -in "$WORK_DIR/server.csr" \
  -CA "$TLS_DIR/ca.crt" \
  -CAkey "$TLS_DIR/ca.key" \
  -CAserial "$TLS_DIR/ca.srl" \
  -CAcreateserial \
  -out "$WORK_DIR/server.crt" \
  -extfile "$OPENSSL_CNF" \
  -extensions server_cert

cat "$WORK_DIR/server.crt" "$TLS_DIR/ca.crt" > "$WORK_DIR/server-bundle.crt"
install -m 600 "$WORK_DIR/server.key" "$TLS_DIR/server.key"
install -m 644 "$WORK_DIR/server.crt" "$TLS_DIR/server.crt"
install -m 644 "$WORK_DIR/server-bundle.crt" "$TLS_DIR/server-bundle.crt"
chmod 600 "$TLS_DIR/ca.key" "$TLS_DIR/ca.srl"
chmod 644 "$TLS_DIR/ca.crt"

if systemctl is-active --quiet enterprise-sso-nginx.service; then
  /usr/local/nginx/sbin/nginx -t -c /etc/enterprise-sso/nginx.conf
  systemctl reload enterprise-sso-nginx.service
fi
