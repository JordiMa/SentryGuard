# Self-Hosting SentryGuard with Docker

Complete guide to deploy SentryGuard on your own server (Synology NAS, VPS, etc.) using Docker Compose.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [DNS & Cloudflare Setup](#3-dns--cloudflare-setup)
4. [Tesla Developer Setup](#4-tesla-developer-setup)
5. [Generate Certificates](#5-generate-certificates)
6. [Deploy with Docker Compose](#6-deploy-with-docker-compose)
7. [Nginx Proxy Manager Setup](#7-nginx-proxy-manager-setup)
8. [Post-Deployment Configuration](#8-post-deployment-configuration)
9. [Environment Variables Reference](#9-environment-variables-reference)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Architecture Overview

```
                    ┌─────────────┐
                    │  Cloudflare │
                    │    (DNS)    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
    ┌─────────▼──┐  ┌──────▼─────┐  ┌──▼──────────┐
    │  Webapp    │  │    API     │  │ Fleet        │
    │  :3000     │  │   :3001    │  │ Telemetry    │
    │ (Next.js) │  │  (NestJS)  │  │   :443       │
    └────────────┘  └──────┬─────┘  └──────┬──────┘
                           │               │
                    ┌──────┼──────┐        │
                    │      │      │        │
              ┌─────▼┐ ┌───▼──┐ ┌▼─────┐ │
              │Postgr│ │Kafka │ │Zookpr│ │
              │  es   │ │      │ │      │ │
              │:5432  │ │:29092│ │:2181 │ │
              └───────┘ └──────┘ └──────┘ │
                                          │
                    ┌─────────────────────┘
                    │  vehicle-command :443
                    │  (Tesla proxy)
                    └─────────────────────
```

**Services:**
- **webapp**: Next.js frontend
- **api**: NestJS backend
- **postgres**: PostgreSQL database
- **kafka + zookeeper**: Message broker for telemetry data
- **fleet-telemetry**: Tesla Fleet Telemetry server (receives vehicle data)
- **vehicle-command**: Tesla Vehicle Command proxy (sends commands to vehicles)

**Docker network**: All services communicate on a `sentryguard` bridge network. Only API, webapp, and fleet-telemetry ports are exposed to the host.

---

## 2. Prerequisites

- A server (Synology NAS, VPS, etc.) with Docker and Docker Compose
- A domain name (e.g., `yourdomain.com`)
- A Cloudflare account (free tier works)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Tesla Developer account (from [developer.tesla.com](https://developer.tesla.com))

---

## 3. DNS & Cloudflare Setup

### 3.1 Create DNS Records

In your Cloudflare DNS dashboard, create these records:

| Record | Type | Content | Proxy |
|--------|------|---------|-------|
| `yourdomain.com` | A | Your server IP | Proxied (orange cloud) |
| `api.yourdomain.com` | A | Your server IP | Proxied (orange cloud) |
| `fleet-telemetry.yourdomain.com` | A | Your server IP | DNS only (grey cloud) |

> **Important**: The fleet-telemetry subdomain MUST be set to "DNS only" (grey cloud), not proxied through Cloudflare. Cloudflare's proxy doesn't handle mTLS/TLS connections on custom ports.

### 3.2 Cloudflare SSL Settings

In Cloudflare → SSL/TLS → Overview:
- Set encryption mode to **Full (strict)**

### 3.3 Generate Cloudflare Origin Certificates

In Cloudflare → SSL/TLS → Origin Server → Create Certificate:
1. Generate a certificate for `*.yourdomain.com` and `yourdomain.com`
2. Save the **Origin Certificate** (PEM) and **Private Key**
3. You'll need these for Nginx Proxy Manager

---

## 4. Tesla Developer Setup

### 4.1 Create a Tesla Developer Application

1. Go to [developer.tesla.com](https://developer.tesla.com) and create an application
2. Set the **Redirect URI** to: `https://api.yourdomain.com/callback/auth`
3. Note your **Client ID** and **Client Secret**
4. Set the **Audience** based on your region:
   - Europe: `https://fleet-api.prd.eu.vn.cloud.tesla.com`
   - North America: `https://fleet-api.prd.na.vn.cloud.tesla.com`
   - Asia Pacific: `https://fleet-api.prd.cn.vn.cloud.tesla.com`

### 4.2 Register as a Fleet API Partner

After creating your application, register it as a partner:

```bash
# Get a client_credentials token first
curl -X POST https://auth.tesla.com/oauth2/v3/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&scope=openid+offline_access+vehicle_device_data+vehicle_cmds+vehicle_location&audience=https://fleet-api.prd.eu.vn.cloud.tesla.com"

# Register as partner
curl -X POST https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/partner_accounts \
  -H "Authorization: Bearer YOUR_CLIENT_CREDENTIALS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domain":"yourdomain.com"}'
```

### 4.3 Upload Public Key to Your Domain

The Tesla well-known public key must be accessible at:
```
https://yourdomain.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

The webapp already proxies this path to the API via `next.config.js`. The API serves the key from the `TESLA_PUBLIC_KEY_BASE64` environment variable.

---

## 5. Generate Certificates

Run this script on your local machine (requires `openssl`):

```bash
./scripts/generate-certs.sh
```

This generates the following files in `fleet-telemetry/certs/`:

| File | Purpose |
|------|---------|
| `ca.key` | Fleet Telemetry CA private key (keep secret) |
| `ca.crt` | Fleet Telemetry CA certificate (needed by API and fleet-telemetry) |
| `tls.key` | Fleet Telemetry server private key |
| `tls.crt` | Fleet Telemetry server certificate (signed by CA) |
| `private-key.pem` | Tesla vehicle command private key (keep secret) |
| `public-key.pem` | Tesla vehicle command public key (publish at well-known URL) |

The script also outputs the base64-encoded values for:
- `LETS_ENCRYPT_CERTIFICATE` (base64 of `ca.crt`)
- `TESLA_PUBLIC_KEY_BASE64` (base64 of `public-key.pem`)

**Save these values** — you'll need them in your `.env` file.

### 5.1 Copy Certificates to Your Server

```bash
# Example for Synology NAS
scp -r fleet-telemetry/ admin@your-nas:/volume1/docker/sentryguard/fleet-telemetry/
```

---

## 6. Deploy with Docker Compose

### 6.1 Create the `.env` File

Create `/volume1/docker/sentryguard/.env` (or equivalent on your server):

```env
# ===== REQUIRED =====

# Database
DATABASE_USER=sentryguard
DATABASE_PASSWORD=CHANGE_ME_to_a_strong_password
DATABASE_NAME=sentryguard

# Security (min 32 chars each)
ENCRYPTION_KEY=CHANGE_ME_to_a_random_32_char_string
JWT_SECRET=CHANGE_ME_to_another_random_32_char_string
JWT_OAUTH_STATE_SECRET=CHANGE_ME_to_another_random_32_char_string

# Telegram
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_BASE=https://api.yourdomain.com
TELEGRAM_WEBHOOK_SECRET_PATH=a_random_20_plus_char_path_segment
TELEGRAM_WEBHOOK_SECRET_TOKEN=a_random_24_plus_char_secret

# Tesla OAuth
TESLA_CLIENT_ID=YOUR_TESLA_CLIENT_ID
TESLA_CLIENT_SECRET=YOUR_TESLA_CLIENT_SECRET
TESLA_AUDIENCE=https://fleet-api.prd.eu.vn.cloud.tesla.com
TESLA_REDIRECT_URI=https://api.yourdomain.com/callback/auth

# Fleet Telemetry
TESLA_FLEET_TELEMETRY_SERVER_HOSTNAME=fleet-telemetry.yourdomain.com
TESLA_FLEET_TELEMETRY_SERVER_PORT=11111

# CA Certificate (base64 of ca.crt - output from generate-certs.sh)
LETS_ENCRYPT_CERTIFICATE=PASTE_BASE64_HERE

# Tesla Public Key (base64 of public-key.pem - output from generate-certs.sh)
TESLA_PUBLIC_KEY_BASE64=PASTE_BASE64_HERE

# Webapp (MUST be set at build time, see GitHub Actions)
WEBAPP_URL=https://yourdomain.com
NEXT_PUBLIC_API_URL=https://api.yourdomain.com

# ===== OPTIONAL =====

# Data path on the host (default: current directory)
SG_DATA_PATH=/volume1/docker/sentryguard

# Host port mappings
API_PORT=3021
WEBAPP_PORT=3020
FLEET_TELEMETRY_PORT=11111

# Logging
LOG_LEVEL=info
```

### 6.2 Deploy

```bash
cd /volume1/docker/sentryguard

# Pull the latest images
docker compose -f docker-compose.selfhost.yml pull

# Start all services
docker compose -f docker-compose.selfhost.yml --env-file .env up -d

# Check logs
docker compose -f docker-compose.selfhost.yml logs -f
```

### 6.3 Verify Services

```bash
# Check all containers are running
docker compose -f docker-compose.selfhost.yml ps

# Check API health
curl -s http://localhost:3021/api/auth/status | head -c 100

# Check webapp
curl -s -o /dev/null -w "%{http_code}" http://localhost:3020
```

---

## 7. Nginx Proxy Manager Setup

### 7.1 Install Nginx Proxy Manager

If not already installed on your NAS:

```bash
docker run -d \
  --name npm \
  --restart unless-stopped \
  -p 80:80 -p 443:443 -p 81:81 \
  -v /volume1/docker/npm/data:/data \
  -v /volume1/docker/npm/letsencrypt:/etc/letsencrypt \
  jc21/nginx-proxy-manager
```

> **Important**: Do NOT use Let's Encrypt certificates with NPM when behind Cloudflare. Use Cloudflare Origin certificates instead.

### 7.2 Create SSL Certificates in NPM

1. Go to **SSL Certificates → Add SSL Certificate → Custom**
2. Name: `Cloudflare Origin - yourdomain.com`
3. Paste the **Certificate** (Origin Certificate PEM from Cloudflare)
4. Paste the **Private Key** (from Cloudflare)
5. Save

### 7.3 Add Proxy Hosts

#### Webapp (`yourdomain.com`)

| Setting | Value |
|---------|-------|
| Domain | `yourdomain.com` |
| Scheme | `http` |
| Forward Hostname/IP | `sentryguard-webapp` (or container IP) |
| Forward Port | `3000` |
| Block Common Exploits | Yes |
| Websockets Support | Yes |
| SSL | Enable → Select `Cloudflare Origin - yourdomain.com` |
| Force SSL | Yes |
| HTTP/2 Support | Yes |
| HSTS Enabled | Yes |

#### API (`api.yourdomain.com`)

| Setting | Value |
|---------|-------|
| Domain | `api.yourdomain.com` |
| Scheme | `http` |
| Forward Hostname/IP | `sentryguard-api` (or container IP) |
| Forward Port | `3001` |
| Block Common Exploits | Yes |
| Websockets Support | Yes |
| SSL | Enable → Select `Cloudflare Origin - yourdomain.com` |
| Force SSL | Yes |
| HTTP/2 Support | Yes |
| HSTS Enabled | Yes |

> **Note**: Use container names (e.g., `sentryguard-api`) as the Forward Hostname only if NPM is on the same Docker network. Otherwise, use the host IP + mapped port (e.g., `192.168.1.x:3021`).

#### Fleet Telemetry (`fleet-telemetry.yourdomain.com`)

For fleet telemetry, since Cloudflare doesn't proxy this (DNS only), you have two options:

**Option A**: Use Cloudflare Origin certificate in NPM (if Cloudflare resolves to your server anyway)

| Setting | Value |
|---------|-------|
| Domain | `fleet-telemetry.yourdomain.com` |
| Scheme | `https` |
| Forward Hostname/IP | `sentryguard-fleet-telemetry` |
| Forward Port | `443` |
| SSL | Enable → Select `Cloudflare Origin - yourdomain.com` |
| Force SSL | Yes |

> **Note**: Since the fleet-telemetry container already terminates TLS with its own self-signed cert, proxying through NPM with SSL requires NPM to trust the fleet-telemetry CA. This is complex. **Option B is recommended.**

**Option B (Recommended)**: Direct connection — expose port 11111 on your router/firewall directly.

In this case, port 11111 on your server maps directly to the fleet-telemetry container port 443 (already configured in docker-compose). No NPM proxy needed.

---

## 8. Post-Deployment Configuration

### 8.1 Virtual Key Pairing

After logging in for the first time:

1. Click "Pair Virtual Key" in the webapp
2. This opens Tesla's website — approve the key in the Tesla app on your phone
3. Return to SentryGuard and refresh vehicles

### 8.2 Verify Fleet Telemetry

From your local machine, test the fleet-telemetry endpoint:

```bash
# Test with self-signed CA
curl -v --cacert fleet-telemetry/certs/ca.crt \
  --resolve fleet-telemetry.yourdomain.com:11111YOUR_SERVER_IP \
  https://fleet-telemetry.yourdomain.com:11111/
```

You should get a TLS handshake (the connection may close quickly — that's normal, it's expecting mTLS).

### 8.3 Verify Vehicle Configuration

Check API logs to confirm telemetry configuration works:

```bash
docker logs sentryguard-api --tail 50 | grep -i "telemetry\|configur\|error"
```

When you enable telemetry for a vehicle, you should see:
```
✅ Telemetry configured for VIN: XXXXXXX
```

If you see `ca is not a valid PEM`, check that `LETS_ENCRYPT_CERTIFICATE` is set correctly (base64 of `ca.crt`).

If you see `invalid domain`, check that `TESLA_FLEET_TELEMETRY_SERVER_HOSTNAME` is just the hostname without `https://` or trailing slash:
```
✅ TESLA_FLEET_TELEMETRY_SERVER_HOSTNAME=fleet-telemetry.yourdomain.com
❌ TESLA_FLEET_TELEMETRY_SERVER_HOSTNAME=https://fleet-telemetry.yourdomain.com/
```

### 8.4 Kafka Topic

The fleet-telemetry server sends vehicle data to the `FleetTelemetry_V` Kafka topic. Make sure the topic is created:

```bash
docker exec sentryguard-kafka kafka-topics --bootstrap-server localhost:9092 --list
```

If `FleetTelemetry_V` is not listed, create it:

```bash
docker exec sentryguard-kafka kafka-topics --bootstrap-server localhost:9092 \
  --create --topic FleetTelemetry_V --partitions 1 --replication-factor 1
```

> **Note**: `KAFKA_AUTO_CREATE_TOPICS_ENABLE=true` is set in the docker-compose, so topics should be created automatically.

---

## 9. Environment Variables Reference

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `ENCRYPTION_KEY` | Token encryption key (min 32 chars) | Random 32+ char string |
| `JWT_SECRET` | JWT signing secret (min 32 chars) | Random 32+ char string |
| `JWT_OAUTH_STATE_SECRET` | OAuth state signing secret (min 32 chars) | Random 32+ char string |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | `123456:ABC-DEF...` |
| `TELEGRAM_WEBHOOK_BASE` | API public URL for Telegram webhooks | `https://api.yourdomain.com` |
| `TELEGRAM_WEBHOOK_SECRET_PATH` | Random URL path (min 16 chars) | Random string |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Webhook verification token (min 24 chars) | Random string |
| `TESLA_CLIENT_ID` | Tesla Developer Client ID | From developer.tesla.com |
| `TESLA_CLIENT_SECRET` | Tesla Developer Client Secret | From developer.tesla.com |
| `TESLA_REDIRECT_URI` | OAuth callback URL | `https://api.yourdomain.com/callback/auth` |
| `TESLA_FLEET_TELEMETRY_SERVER_HOSTNAME` | Fleet telemetry public hostname | `fleet-telemetry.yourdomain.com` |
| `LETS_ENCRYPT_CERTIFICATE` | Base64 of fleet-telemetry CA cert | Output from `generate-certs.sh` |
| `TESLA_PUBLIC_KEY_BASE64` | Base64 of Tesla public key | Output from `generate-certs.sh` |
| `WEBAPP_URL` | Webapp public URL (for CORS + redirects) | `https://yourdomain.com` |

### Build-Time Variables (in GitHub Actions)

These are baked into the Docker image at build time and **cannot be changed after build**:

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | API URL for webapp client-side calls | `https://api.yourdomain.com` |
| `NEXT_PUBLIC_VIRTUAL_KEY_PAIRING_URL` | Tesla virtual key pairing URL | `https://tesla.com/_ak/yourdomain.com` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_USER` | `sentryguard` | PostgreSQL user |
| `DATABASE_PASSWORD` | `sentryguard` | PostgreSQL password |
| `DATABASE_NAME` | `sentryguard` | PostgreSQL database name |
| `DATABASE_SSL` | `false` | Enable SSL for DB connection |
| `DATABASE_RUN_MIGRATIONS` | `true` | Run migrations on startup |
| `TESLA_AUDIENCE` | `https://fleet-api.prd.eu.vn.cloud.tesla.com` | Tesla API audience (region) |
| `TESLA_FLEET_TELEMETRY_SERVER_PORT` | `11111` | Fleet telemetry external port |
| `KAFKA_TOPIC` | `FleetTelemetry_V` | Kafka topic for telemetry |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `SG_DATA_PATH` | `.` | Path to config/certs on host |
| `API_PORT` | `3021` | Host port for API |
| `WEBAPP_PORT` | `3020` | Host port for webapp |
| `FLEET_TELEMETRY_PORT` | `11111` | Host port for fleet-telemetry |
| `TESLA_KEY_NAME` | `sentryguard` | Name for the virtual key registration |
| `SENTRY_MODE_INTERVAL_SECONDS` | `30` | Sentry mode telemetry interval |
| `BREAK_IN_MONITORING_INTERVAL_SECONDS` | `30` | Break-in monitoring interval |

---

## 10. Troubleshooting

### API returns "ca is not a valid PEM"

The `LETS_ENCRYPT_CERTIFICATE` env var is empty or invalid. Regenerate:

```bash
base64 < fleet-telemetry/certs/ca.crt | tr -d '\n'
```

Copy the output and set it in your `.env`.

### API returns "invalid domain"

`TESLA_FLEET_TELEMETRY_SERVER_HOSTNAME` must be just the hostname (no protocol, no trailing slash):

```
✅ fleet-telemetry.yourdomain.com
❌ https://fleet-telemetry.yourdomain.com/
```

### Telegram bot doesn't respond to buttons

Telegram limits `callback_data` to 64 bytes. If you see `BUTTON_DATA_INVALID` in logs, the callback data is too long. This has been fixed in recent versions by shortening prefixes.

### Fleet telemetry TLS errors

Verify the fleet-telemetry certificate is signed by the CA:

```bash
openssl verify -CAfile fleet-telemetry/certs/ca.crt fleet-telemetry/certs/tls.crt
```

### Database migration errors

The API runs migrations on startup. If you see migration errors:

```bash
docker logs sentryguard-api 2>&1 | grep -i "migration\|error"
```

### Vehicle configuration returns "Configuration skipped"

Possible reasons:
- `missing_key`: Virtual key not yet paired — click "Pair Virtual Key" in the webapp
- `unsupported_hardware`: Pre-2018 Model S/X don't support telemetry
- `unsupported_firmware`: Vehicle firmware needs updating
- `max_configs`: Too many telemetry configs already registered with Tesla

### Port conflicts on Synology

Synology NAS often uses port 443. The docker-compose maps:
- `3021:3001` (API)
- `3020:3000` (webapp)
- `11111:443` (fleet-telemetry)

Make sure these ports are available on your host.

### Reset everything

```bash
docker compose -f docker-compose.selfhost.yml down -v  # removes volumes too!
docker compose -f docker-compose.selfhost.yml --env-file .env up -d
```

> **Warning**: `-v` deletes the PostgreSQL data volume. Only use this for a fresh start.