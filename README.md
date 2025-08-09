# Whatsapp-Bot

Minimal WhatsApp bot server using `whatsapp-web.js` with an HTTP API.

## Run

1) Install deps

Local (Ubuntu/Debian):

```
sudo apt update && sudo xargs -a packages.txt apt install -y
npm install
```

Render / generic managed Node host (no root apt):

Set in the service settings:

```
Build Command: npm install
Start Command: npm start
```

If the host is missing required Chromium system libraries (you see errors about missing .so files), deploy with the provided Dockerfile instead.

2) Start server (defaults to port 10000)

```
npm start
```

3) Scan the QR printed in the terminal with the WhatsApp app (Linked devices). You can also fetch it via HTTP at `/qr` or `/qr.png`.

## Environment

- `PORT` (default `10000`)
- `SESSION_PATH` (default `.session`)

## Endpoints

- `GET /` — health/status
- `GET /qr` — latest QR content as JSON (404 if not available, 204 if already ready)
- `GET /qr.png` — latest QR as PNG (404 if not available, 204 if already ready)
- `POST /send` — send a message

### POST /send

Body JSON:

```
{
	"number": "15551234567", // optional if jid provided
	"jid": "15551234567@c.us", // optional alternative to number
	"message": "Hello from API"
}
```

Response:

```
{ "success": true, "to": "15551234567@c.us" }
```

## Testing with curl

```
BASE_URL=http://localhost:10000

# status
curl -i "$BASE_URL/"

# get QR as JSON (when not yet ready)
curl -i "$BASE_URL/qr"

# get QR as PNG
curl -i "$BASE_URL/qr.png" -o qr.png

# send a message
curl -i -X POST "$BASE_URL/send" \
	-H "Content-Type: application/json" \
	-d '{"number":"15551234567","message":"Hello from API"}'
```

## Notes

- Requires scanning the QR on first run. Session is persisted under `.session/` by default.
- Ensure numbers are in international format without leading `+`.