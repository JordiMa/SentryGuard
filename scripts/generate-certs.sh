#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERTS_DIR="${PROJECT_ROOT}/fleet-telemetry/certs"

mkdir -p "${CERTS_DIR}"

if [ ! -f "${CERTS_DIR}/ca.key" ] || [ ! -f "${CERTS_DIR}/ca.crt" ]; then
  echo "Generating Fleet Telemetry CA certificate..."
  openssl ecparam -name prime256v1 -genkey -noout -out "${CERTS_DIR}/ca.key"
  openssl req -x509 -nodes -new -key "${CERTS_DIR}/ca.key" \
    -subj "/CN=SentryGuard Fleet Telemetry CA" \
    -out "${CERTS_DIR}/ca.crt" \
    -sha256 -days 3650 \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  echo "CA certificate generated."
else
  echo "CA certificate already exists, skipping generation."
fi

if [ ! -f "${CERTS_DIR}/tls.key" ] || [ ! -f "${CERTS_DIR}/tls.crt" ]; then
  echo "Generating Fleet Telemetry server certificate signed by CA..."
  FLEET_HOSTNAME="${FLEET_HOSTNAME:-fleet-telemetry-sentryguard.jordimarzo.fr}"

  openssl ecparam -name prime256v1 -genkey -noout -out "${CERTS_DIR}/tls.key"

  openssl req -new -key "${CERTS_DIR}/tls.key" \
    -subj "/CN=${FLEET_HOSTNAME}" \
    -out "${CERTS_DIR}/tls.csr"

  openssl x509 -req -in "${CERTS_DIR}/tls.csr" \
    -CA "${CERTS_DIR}/ca.crt" \
    -CAkey "${CERTS_DIR}/ca.key" \
    -CAcreateserial \
    -out "${CERTS_DIR}/tls.crt" \
    -sha256 -days 3650 \
    -extfile <(printf "extendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyAgreement\nsubjectAltName=DNS:${FLEET_HOSTNAME}")

  rm -f "${CERTS_DIR}/tls.csr" "${CERTS_DIR}/ca.srl"
  echo "Server TLS certificate generated and signed by CA."
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
  echo "Also add this key to your domain at:"
  echo "https://your-domain.com/.well-known/appspecific/com.tesla.3p.public-key.pem"
else
  echo "Command authentication key pair already exists, skipping generation."
fi

echo ""
echo "Certificate files:"
ls -la "${CERTS_DIR}/"

echo ""
echo "========================================="
echo "Required environment variables for .env:"
echo "========================================="
CA_CERT_BASE64=$(base64 < "${CERTS_DIR}/ca.crt" | tr -d '\n')
PUBKEY_BASE64=$(base64 < "${CERTS_DIR}/public-key.pem" | tr -d '\n')
echo ""
echo "LETS_ENCRYPT_CERTIFICATE=${CA_CERT_BASE64}"
echo ""
echo "TESLA_PUBLIC_KEY_BASE64=${PUBKEY_BASE64}"