#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERTS_DIR="${PROJECT_ROOT}/fleet-telemetry/certs"

mkdir -p "${CERTS_DIR}"

if [ ! -f "${CERTS_DIR}/tls.key" ] || [ ! -f "${CERTS_DIR}/tls.crt" ]; then
  echo "Generating Fleet Telemetry TLS certificate..."
  openssl ecparam -name prime256v1 -genkey -noout -out "${CERTS_DIR}/tls.key"
  openssl req -x509 -nodes -new -key "${CERTS_DIR}/tls.key" \
    -subj "/CN=fleet-telemetry" \
    -out "${CERTS_DIR}/tls.crt" \
    -sha256 -days 3650 \
    -addext "extendedKeyUsage = serverAuth" \
    -addext "keyUsage = digitalSignature, keyCertSign, keyAgreement"
  echo "TLS certificate generated."
else
  echo "TLS certificate already exists, skipping generation."
fi

if [ ! -f "${CERTS_DIR}/private-key.pem" ] || [ ! -f "${CERTS_DIR}/public-key.pem" ]; then
  echo "Generating Tesla command authentication key pair..."
  openssl ecparam -name prime256v1 -genkey -noout -out "${CERTS_DIR}/private-key.pem"
  openssl ec -in "${CERTS_DIR}/private-key.pem" -pubout -out "${CERTS_DIR}/public-key.pem"
  echo "Key pair generated."
  echo ""
  echo "IMPORTANT: Register this public key at https://developer.tesla.com"
  echo "Public key location: ${CERTS_DIR}/public-key.pem"
  echo ""
  echo "Also add this key to your Tesla Fleet Telemetry config at:"
  echo "https://your-domain.com/.well-known/appspecific/com.tesla.3p.public-key.pem"
else
  echo "Command authentication key pair already exists, skipping generation."
fi

echo ""
echo "Certificate files:"
ls -la "${CERTS_DIR}/"