# SMS Notification Setup

Your scraper can now ping your phone via a free webhook service.

## Quick Setup (IFTTT - Free)

1. **Go to IFTTT**: https://ifttt.com/create
2. **Choose "If This"**: Select "Webhooks" → "Receive a web request"
   - Event name: `mower_alert`
3. **Choose "Then That"**: Select "SMS" (or "Notifications" for app push)
   - Message: `{{Value1}}`
4. **Get your webhook URL**:
   - Go to https://ifttt.com/maker_webhooks → Documentation
   - Copy your URL (looks like: `https://maker.ifttt.com/trigger/mower_alert/with/key/YOUR_KEY`)

## In the UI (http://localhost:8020)

1. Paste your IFTTT webhook URL
2. Enter your phone number (optional, just for reference)
3. Check "Enable notifications"
4. Click "Save Notification Settings"

## How it works

When the scraper finds results, it POSTs to your webhook:
```json
{
  "phone": "+1234567890",
  "message": "Found 5 mower(s): Cub Cadet - $800, ...",
  "deals": [...]
}
```

IFTTT/Zapier/Pushover will forward that to SMS/push notification.

## Alternative Services (all free tiers)

- **Pushover**: https://pushover.net (app notifications, $5 one-time)
- **Zapier**: https://zapier.com (webhook → SMS via Twilio free tier)
- **ntfy.sh**: https://ntfy.sh (100% free push notifications)
