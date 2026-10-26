# Mastercard transaction activity signal

## What this integration can and cannot measure

LIVE CITY uses Mastercard Transaction Notifications only for cards whose
cardholders explicitly enrolled and consented through the Mastercard flow. The
feed is therefore a sample of purchase activity, not a list of every payment at
a venue and not a direct people counter.

The production integration must use the Mastercard product granted to the LIVE
CITY account. Mastercard production authentication and webhook verification
(including mTLS or signatures required by the onboarding contract) terminate
at a trusted gateway. The gateway forwards the following normalized envelope to
the Supabase `mastercard-transaction-ingest` function:

```json
{
  "schema": "live-city.mastercard-transaction.v1",
  "merchantId": "merchant-location-id",
  "transactionReference": "provider-transaction-reference",
  "occurredAt": "2026-10-26T18:17:00.000Z",
  "eventStage": "authorization",
  "transactionStatus": "approved",
  "consentVerified": true
}
```

The gateway authenticates with `x-mastercard-ingest-secret`. Raw Mastercard
payloads and credentials must never be sent to Expo or persisted by this
function.

## Data minimisation

The ingest function:

- accepts only consent-verified normalized events;
- ignores declined transactions;
- converts the transaction reference to a salted SHA-256 fingerprint;
- stores no PAN, card reference, amount, customer identifier or merchant name;
- updates an existing row for authorization/clearing/reversal events, preventing
  duplicate counting;
- deletes event-level rows after 48 hours;
- publishes a venue snapshot only when at least five approved transactions are
  present in a completed 20-minute window.

Only merchants in `mastercard_merchant_mappings` can contribute. This guarantees
that the signal appears only on a known LIVE CITY venue where a mapped purchase
was made.

## Crowd calculation

Transaction counts are normalized against the distribution of the same venue:

| Venue percentile | Crowd score |
| --- | ---: |
| 0 transactions | 5 |
| p25 | 25 |
| p50 | 50 |
| p75 | 72 |
| p90 | 88 |
| historical maximum | 100 |

A venue profile becomes mature after at least 12 published windows across at
least three distinct days. Before that point, a conservative logarithmic
cold-start score is used with a maximum confidence of 0.45.

The mature Mastercard signal has a maximum engine weight of `0.72`; fresh
BestTime or qualified LIVE CITY telemetry have weight `1`. The current crowd
score is the weighted mean of available observations, followed by the existing
capped event boost. Consequently:

- BestTime + Mastercard: both influence the result;
- Mastercard only: a labelled **transaction proxy**, never verified foot
  traffic;
- no Mastercard data: the existing BestTime/telemetry/history behavior is
  unchanged;
- reversals and duplicate notifications never increase the count.

The source coverage field represents the estimated share of venue activity
visible to the contracted Mastercard feed. It affects confidence, not the raw
score, and must be calibrated from the commercial dataset rather than guessed.

## Required production configuration

Supabase Edge Function secrets:

- `MASTERCARD_INGEST_SECRET`: high-entropy secret shared only with the trusted
  webhook gateway;
- `MASTERCARD_TRANSACTION_HASH_SALT`: independent high-entropy salt used for
  short-lived transaction fingerprints;
- existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and crowd refresh secrets.

Operational setup:

1. obtain production access to Mastercard Transaction Notifications and Consent
   Management, or contract an approved aggregated merchant-insights feed;
2. configure the trusted gateway according to Mastercard's production security
   requirements;
3. add reviewed merchant-to-place rows to
   `mastercard_merchant_mappings`—never fuzzy-match payments automatically;
4. send sandbox notifications and verify authorization, duplicate, clearing,
   reversal and unmapped-merchant behavior;
5. deploy the migration and the two Mastercard Edge Functions;
6. monitor `app-health` until aggregates and venue profiles become fresh.

## Interpretation

One payment is not one visitor: a person may make multiple purchases, pay cash,
use another network, transact online, or pay for a group. The UI therefore says
“Transazioni Mastercard aggregate · proxy, non conteggio persone”. The signal
must not be marketed as Mastercard's total venue foot traffic.
