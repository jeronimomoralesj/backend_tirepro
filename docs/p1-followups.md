# P1 follow-ups blocked on user input

Three P1 items from the SEO/perf audit need a decision or external
credential before code can land. Each entry below sketches the design
so implementation can move quickly once unblocked.

---

## 1. WhatsApp order-status notifications

**Goal.** Send buyers a WhatsApp message on each order milestone:
`pendiente → confirmado → enviado → entregado`. Doubles open rate vs
email and is the channel of choice in Colombia.

**Decision needed: which provider?**

| Option                            | Setup speed | Cost (per CO msg)         | Ergonomics                                                                                                                                                          |
| --------------------------------- | ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Meta WhatsApp Business API**    | 5–10 days   | ~$0.005–0.02 per template | Cheapest; requires Meta Business verification + a Business Phone Number; templates need pre-approval (24–72h each).                                                 |
| **Twilio WhatsApp**               | Same day    | ~$0.04 per message        | Drop-in API; easiest to integrate; templates also pre-approved by Meta but Twilio handles the back-and-forth. Costs more per message.                                |
| **Wati / 360dialog (BSPs)**       | 1–3 days    | ~$0.01–0.03 per template  | Local Colombian sales rep; bundled UI for template management + a shared inbox. Vendor lock-in; APIs proxy to Meta under the hood.                                  |

**Recommendation.** Start with **Twilio** for v1 — same-day setup,
fewer moving parts, and the message volume is low enough (a few
hundred orders/month) that the per-message premium is negligible vs
engineering time. Migrate to Meta direct or 360dialog when monthly
volume passes ~5K messages.

**What you need to provide:**
- A Twilio account SID + auth token, and a WhatsApp Business sender
  number (Twilio sandbox works for dev).
- Approved template names / variables for each milestone (Twilio's
  console handles the Meta back-and-forth).

**Implementation outline once unblocked:**
- `src/integrations/whatsapp/whatsapp.service.ts` with one
  `sendTemplate(to, templateName, variables)` method.
- Hook into `marketplace.service.ts` `updateOrderStatus` so every
  status change fires both an email AND a WhatsApp template.
- New env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_WHATSAPP_FROM` (e.g. `whatsapp:+14155238886` for sandbox).
- 4 templates: `order_pendiente`, `order_confirmado`,
  `order_enviado`, `order_entregado`. Variables: buyer name, order
  number, listing label, tracking URL.

---

## 2. Saved-card UX in Bold checkout

**Goal.** First-time buyer pays with card → store the Bold
tokenization reference → on next visit, surface "use saved card" so
the buyer skips the redirect to Bold's hosted checkout.

**What we have today.** Bold checkout is via "Link de pagos": each
checkout creates a fresh `boldOrderId` with the buyer's full card
data flowing through Bold's hosted page. We never see the PAN /
token, only the resulting `boldPaymentId` after the webhook
confirms.

**Decision needed: does our Bold contract include tokenization?**
Tokenization (saved cards / one-click reuse) is a separate Bold
product called **Pagos Recurrentes** or **Bold Tokenizer**. It's not
part of the standard Link de pagos integration. Tiers:

| Tier                   | Tokenization | Notes                                                                                              |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| Bold Link de pagos     | ❌            | Current integration. Each charge is a fresh redirect.                                              |
| Bold Pagos Recurrentes | ✅ (limited)  | Returns a `customer_id` after the first successful payment; subsequent charges via API call only.  |
| Bold Tokenizer + 3DS   | ✅ (full)     | PCI-compliant card-on-file. Higher MDR, contract negotiation needed.                               |

**Action items for the user:**
- Email integraciones@bold.co or your account exec, ask whether the
  TirePro merchant ID (`KBHC6AMGHZ`) is provisioned for **Pagos
  Recurrentes** or **Tokenizer**.
- If yes: ask for the API docs for `POST /v1/customers` and
  `POST /v1/payments/with-token` (exact endpoint paths vary by
  contract).
- If no: ask for the upgrade quote (typically a one-time fee +
  slightly higher MDR on tokenized charges).

**Implementation outline once unblocked:**
- Add `User.savedCards Json?` (array of `{ tokenId, last4, brand,
  expMonth, expYear }`).
- New endpoint `POST /payments/bold/checkout-with-token` that hits
  Bold's tokenized-charge API directly instead of returning a
  redirect URL.
- Cart UI: detect `user.savedCards` server-side and show a "Pagar
  con tarjeta guardada (•••• 4242)" radio above the regular Bold
  button. Falls back to redirect on tokenized-charge failure.
- Webhook handler stores `tokenId` returned in the first successful
  payment's response on the `User` row.

---

## 3. CloudFront in front of S3

**Goal.** CDN edge in front of the product-image S3 bucket so image
fetches don't hit `s3.us-east-1.amazonaws.com` from Bogotá (~300 ms
round-trip) but a CloudFront edge in `bog50` (~5 ms). Improves LCP
on `/marketplace` and `/marketplace/product/*`.

**Action items for the user (AWS console):**

1. **CloudFront → Create distribution**
   - Origin domain: the existing S3 bucket (e.g.
     `tirepro-product-images.s3.amazonaws.com`).
   - Origin access: pick "Origin access control settings
     (recommended)" → CloudFront creates an OAC and prompts to
     update the bucket policy. Click through.
   - Viewer protocol policy: "Redirect HTTP to HTTPS".
   - Allowed HTTP methods: GET, HEAD.
   - Cache policy: "CachingOptimized".
   - Compress objects automatically: yes.
   - Price class: "Use only North America and Europe" — covers
     Bogotá via `bog50` edge for ~30% of the global price-class
     cost; "Use all edge locations" if budget allows.
   - Default root object: leave blank.

2. **Custom domain (optional but recommended)**
   - Point `cdn.tirepro.com.co` → CloudFront via a CNAME in your
     DNS provider.
   - Alternate domain name on the distribution + ACM certificate
     in `us-east-1` (CloudFront only consumes ACM certs from
     `us-east-1`).

3. **Code change required after distribution is live:**
   - Find every `https://<bucket>.s3.amazonaws.com/...` in the
     codebase and rewrite the prefix to the CloudFront domain.
     Tracked locations:
     - Backend: `S3Service.getPublicUrl()` — single source of
       truth for new uploads. Update once.
     - Frontend: `next.config.ts` `images.remotePatterns` already
       allows arbitrary `https`, so no config change needed there;
       existing rows with the old S3 URL keep working until
       overwritten.
   - Optional: write a one-shot SQL `UPDATE` to rewrite existing
     `imageUrls[]` from the S3 host to the CloudFront host (so
     historical listings get the CDN benefit too).

4. **Verify.** Hit a product image via the new CloudFront URL +
   curl `-I`; first response should show `X-Cache: Miss from
   cloudfront`, second within a minute should show `X-Cache: Hit
   from cloudfront`.

**No code change needed in this repo until the distribution is
live and the user hands me the domain.** Once shared, swapping the
S3 host in `S3Service` is a 5-minute commit.

---

## Status legend

- **WhatsApp:** waiting on provider choice + Twilio (or alt)
  credentials.
- **Saved cards:** waiting on confirmation that Bold's tier
  supports tokenization.
- **CloudFront:** waiting on AWS console action; code follow-up
  is trivial once distribution domain is known.
