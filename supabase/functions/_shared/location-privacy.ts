const encoder = new TextEncoder();

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function uuidFromHex(hex: string): string {
  const value = hex.slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export async function dailyLocationSessionId(
  userId: string,
  date: Date,
  secret: string,
): Promise<string> {
  if (!userId || secret.length < 32) throw new Error("Location pseudonym configuration is invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${userId}:${utcDay(date)}`),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return uuidFromHex(hex);
}

export function locationRevocationDays(now: Date): Date[] {
  return [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)];
}
