import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-mastercard-ingest-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type NormalizedMastercardEvent = {
  schema: "live-city.mastercard-transaction.v1";
  merchantId: string;
  transactionReference: string;
  occurredAt: string;
  eventStage: "authorization" | "clearing";
  transactionStatus: "approved" | "declined" | "reversed";
  consentVerified: true;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validIdentifier(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseEvent(value: unknown): NormalizedMastercardEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (
    event.schema !== "live-city.mastercard-transaction.v1" ||
    !validIdentifier(event.merchantId) ||
    !validIdentifier(event.transactionReference) ||
    !validIdentifier(event.occurredAt, 64) ||
    !["authorization", "clearing"].includes(String(event.eventStage)) ||
    !["approved", "declined", "reversed"].includes(String(event.transactionStatus)) ||
    event.consentVerified !== true
  ) {
    return null;
  }

  const occurredAt = new Date(event.occurredAt as string);
  const now = Date.now();
  if (
    !Number.isFinite(occurredAt.getTime()) ||
    occurredAt.getTime() > now + 5 * 60_000 ||
    occurredAt.getTime() < now - 7 * 24 * 60 * 60_000
  ) {
    return null;
  }

  return event as NormalizedMastercardEvent;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const expectedSecret = requiredEnv("MASTERCARD_INGEST_SECRET");
    if (request.headers.get("x-mastercard-ingest-secret") !== expectedSecret) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    // Mastercard production webhook authentication (including any mTLS or
    // provider signature required by the customer's onboarding contract) must
    // terminate at a trusted gateway. The gateway sends only this normalized,
    // consent-verified envelope; raw Mastercard payloads never enter Supabase.
    const event = parseEvent(await request.json().catch(() => null));
    if (!event) return json({ ok: false, error: "Invalid normalized event" }, 400);

    if (event.transactionStatus === "declined") {
      return json({ ok: true, stored: false, reason: "Declined transactions are ignored" }, 202);
    }

    const supabase = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: mapping, error: mappingError } = await supabase
      .from("mastercard_merchant_mappings")
      .select("place_id")
      .eq("mastercard_merchant_id", event.merchantId)
      .eq("is_active", true)
      .maybeSingle();
    if (mappingError) throw new Error(`Merchant mapping lookup failed: ${mappingError.message}`);
    if (!mapping) {
      // Acknowledge safely so the provider does not retry forever. The raw
      // merchant or transaction reference is deliberately not retained.
      return json({ ok: true, stored: false, reason: "Merchant is not mapped" }, 202);
    }

    const fingerprint = await sha256(
      `${requiredEnv("MASTERCARD_TRANSACTION_HASH_SALT")}|${event.merchantId}|${event.transactionReference}`,
    );
    const { error: upsertError } = await supabase
      .from("mastercard_transaction_events")
      .upsert({
        provider_transaction_hash: fingerprint,
        place_id: mapping.place_id,
        event_stage: event.eventStage,
        transaction_status: event.transactionStatus,
        occurred_at: event.occurredAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: "provider_transaction_hash" });
    if (upsertError) throw new Error(`Transaction event upsert failed: ${upsertError.message}`);

    return json({ ok: true, stored: true, dataClass: "deidentified_transaction_event" }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Mastercard ingest error";
    console.error("MASTERCARD INGEST ERROR", { message });
    return json({ ok: false, error: message }, 500);
  }
});
