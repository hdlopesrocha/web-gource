#!/usr/bin/env bash
set -euo pipefail

# Generate the self-signed certificate used by `npm run dev`.
#
# The certificate covers localhost and the machine's current LAN addresses so
# the same server can be opened from another device without a hostname mismatch.
# Browsers still show a warning because the certificate is not publicly trusted.
# Run `npm run cert:dev` after changing networks to regenerate it.

cert_dir="${DEV_CERT_DIR:-.cert}"
cert="$cert_dir/dev.crt"
key="$cert_dir/dev.key"
force="${1:-}"

if [[ "$force" != "--force" && -s "$cert" && -s "$key" ]]; then
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate the local HTTPS certificate." >&2
  exit 1
fi

mkdir -p "$cert_dir"
chmod 700 "$cert_dir"

san="DNS:localhost,IP:127.0.0.1,IP:::1"
host_name="$(hostname 2>/dev/null || true)"
if [[ -n "$host_name" ]]; then
  san+=",DNS:$host_name"
  # mDNS names are common on a LAN (for example, um690s.local).
  if [[ "$host_name" != *.local ]]; then
    san+=",DNS:$host_name.local"
  fi
fi

# hostname -I is Linux-specific; ignore it where it is unavailable.
for ip in $(hostname -I 2>/dev/null || true); do
  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ && "$ip" != "127.0.0.1" ]]; then
    san+=",IP:$ip"
  fi
done

openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -days 825 \
  -keyout "$key" -out "$cert" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=$san" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  >/dev/null 2>&1

chmod 600 "$key"
echo "Generated self-signed development certificate in $cert_dir for $san"
