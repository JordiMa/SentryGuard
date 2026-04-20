# SentryGuard - Full Tesla Integration Setup

This guide sets up **real** Tesla telemetry: real vehicle data, real alerts, real commands.

## Prerequisites

- A domain name (e.g., `yourdomain.com`)
- A reverse proxy (Nginx Proxy Manager, Traefik, Caddy) on your NAS
- Docker + Docker Compose on your NAS
- A Tesla Developer account (developer.tesla.com)

## Architecture

```
Internet                              Your NAS (Docker)
────────                              ──────────────────
                                      ┌─────────────────┐
Tesla vehicles ──TLS──► Reverse Proxy ►│ fleet-telemetry  │──► kafka ──► api ──► telegram
                                      │   :443           │
api.yourdomain.com ► Reverse Proxy ►  │ api :3001        │
yourdomain.com     ► Reverse Proxy ►  │ webapp :3000     │
                                      │ vehicle-command   │
                                      │   :443 (internal)│
                                      └─────────────────┘
```

## Step 1: DNS

Point these records to your NAS public IP:

| Subdomain | Type | Target |
|-----------|------|--------|
| `yourdomain.com` | A | NAS IP |
| `api.yourdomain.com` | A | NAS IP |
| `fleet-telemetry.yourdomain.com` | A | NAS IP |

## Step 2: Generate Keys and Certificates

```bash
cd /path/to/SentryGuard

# Generate TLS certs for Fleet Telemetry + Tesla command auth keys
./scripts/generate-certs.sh
```

This creates `fleet-telemetry/certs/`:
- `tls.key` + `tls.crt` — TLS certificate for Fleet Telemetry server
- `private-key.pem` — Tesla command authentication private key
- `public-key.pem` — Tesla command authentication public key

**Get the base64-encoded public key for .env:**
```bash
cat fleet-telemetry/certs/public-key.pem | base64 | tr -d '\n'
# Copy the output → TESLA_PUBLIC_KEY_BASE64 in .env
```

## Step 3: Configure .env

```bash
cp .env.docker .env
nano .env
```

### Minimum required values:

```env
# ── Database ──
DATABASE_USER=sentryguard
DATABASE_PASSWORD=<generate a strong password>
DATABASE_NAME=sentryguard

# ── Security (generate each with: openssl rand -base64 32) ──
ENCRYPTION_KEY=<openssl rand -base64 32>
JWT_SECRET=<openssl rand -base64 32>
JWT_OAUTH_STATE_SECRET=<openssl rand -base64 32>

# ── Telegram ──
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_BASE=https://api.yourdomain.com
TELEGRAM_WEBHOOK_SECRET_PATH=<openssl rand -hex 16>
TELEGRAM_WEBHOOK_SECRET_TOKEN=<openssl rand -hex 24>

# ── Tesla ──
TESLA_CLIENT_ID=<from developer.tesla.com>
TESLA_CLIENT_SECRET=<from developer.tesla.com>
TESLA_AUDIENCE=https://fleet-api.prd.eu.vn.cloud.tesla.com
TESLA_REDIRECT_URI=https://yourdomain.com/callback/auth
TESLA_FLEET_TELEMETRY_SERVER_HOSTNAME=fleet-telemetry.yourdomain.com
TESLA_FLEET_TELEMETRY_SERVER_PORT=443
TESLA_PUBLIC_KEY_BASE64=<output from step 2>

# ── Fleet Telemetry ──
FLEET_TELEMETRY_PORT=4443

# ── Webapp ──
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
WEBAPP_URL=https://yourdomain.com
```

## Step 4: Update Fleet Telemetry config

Edit `fleet-telemetry/config.json` and set the hostname:

```json
{
  "host": "0.0.0.0",
  "port": 443,
  "namespace": "FleetTelemetry",
  ...
}
```

The `kafka.bootstrap.servers` should be `kafka:29092` (already configured).

## Step 5: Start Docker

```bash
docker compose -f docker-compose.nas.yml --env-file .env up -d
```

## Step 6: Configure Reverse Proxy

### Nginx Proxy Manager example:

| Domain | Scheme | Forward to |
|--------|--------|-----------|
| `yourdomain.com` | http | `http://sentryguard-webapp:3000` |
| `api.yourdomain.com` | http | `http://sentryguard-api:3001` |
| `fleet-telemetry.yourdomain.com` | https | `https://sentryguard-fleet-telemetry:443` |

**Important for fleet-telemetry:** This must be **TLS passthrough** or terminate TLS and forward to the container's port 443 with HTTPS. The Fleet Telemetry server handles its own TLS.

For Nginx Proxy Manager, you need a **stream/pass-through** config. Add this to your Nginx `custom/nginx/stream.conf`:

```nginx
stream {
    server {
        listen 4443;
        ssl_preread on;
        proxy_pass sentryguard-fleet-telemetry:443;
    }
}
```

Or use Traefik with TCP routing, or Caddy with a reverse proxy to `https://sentryguard-fleet-telemetry:443` with `insecure_skip_verify`.

**Alternatively**, if your reverse proxy terminates TLS, you can configure Fleet Telemetry without TLS and let the reverse proxy handle it. Update the Fleet Telemetry config and expose a different port.

### Simplest approach: Expose Fleet Telemetry directly

Configure your router to forward port **443** on the `fleet-telemetry` subdomain IP directly to the container. Let Fleet Telemetry handle TLS itself.

```bash
# In .env:
FLEET_TELEMETRY_PORT=443
```

Then in your router: forward port 443 TCP to your NAS IP:443.

## Step 7: Register with Tesla

### 7a. Get a Partner Token

```bash
curl -X POST https://auth.tesla.com/oauth2/v3/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&scope=openid&audience=https://fleet-api.prd.eu.vn.cloud.tesla.com"
```

### 7b. Register your application

```bash
curl -X POST https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/partner_accounts \
  -H "Authorization: Bearer PARTNER_TOKEN_FROM_7a" \
  -H "Content-Type: application/json" \
  -d '{"domain": "yourdomain.com"}'
```

Tesla will verify that `https://yourdomain.com/.well-known/appspecific/com.tesla.3p.public-key.pem` returns your public key.

### 7c. Pair your vehicle

From the Tesla app (v4.27.3+), open this link:

```
https://tesla.com/_ak/yourdomain.com
```

This enrolls your public key on the vehicle so it accepts commands from your app.

## Step 8: Configure telemetry for your vehicle

Log in to SentryGuard webapp, go to your vehicle, and enable Sentry Mode monitoring. This will call the Tesla Fleet API to configure your vehicle to stream telemetry data to your Fleet Telemetry server.

## Step 9: Verify

```bash
# Check Fleet Telemetry is reachable
curl -k https://fleet-telemetry.yourdomain.com:443

# Check Kafka topic has data
docker compose -f docker-compose.nas.yml exec kafka \
  kafka-console-consumer --bootstrap-server localhost:9092 --topic FleetTelemetry_V --from-beginning --max-messages 5

# Check API logs
docker compose -f docker-compose.nas.yml logs api
```

## Troubleshooting

### Vehicles not connecting to Fleet Telemetry
- Ensure `fleet-telemetry.yourdomain.com` resolves to your public IP
- Verify the TLS certificate is valid (or self-signed with the vehicle accepting it)
- Check that port 443 is open on your router and forwarded to the container

### Commands not working (flash/honk)
- Ensure `vehicle-command` container is running
- Verify `TESLA_PUBLIC_KEY_BASE64` matches the public key you registered
- Check that you completed Step 7c (vehicle key pairing)

### Public key endpoint not working
- Verify `TESLA_PUBLIC_KEY_BASE64` is set correctly in `.env`
- Test: `curl https://yourdomain.com/.well-known/appspecific/com.tesla.3p.public-key.pem`
- It should return your PEM public key

### Telegram not sending alerts
- Check `TELEGRAM_MODE=polling` for testing (no webhook needed)
- For production: `TELEGRAM_MODE=webhook` with `TELEGRAM_WEBHOOK_BASE=https://api.yourdomain.com`