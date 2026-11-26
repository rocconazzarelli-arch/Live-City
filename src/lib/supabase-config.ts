const configuredUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;

/**
 * Public project URL bundled into the Expo client. This value is not a secret,
 * but it must be supplied explicitly so a staging build can never silently
 * connect to the production Supabase project.
 */
export const SUPABASE_URL = configuredUrl?.replace(/\/+$/, '') ?? '';

export function requireSupabaseUrl() {
  if (!SUPABASE_URL) {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL non configurato');
  }
  return SUPABASE_URL;
}

export function supabaseFunctionUrl(functionName: string) {
  return SUPABASE_URL
    ? `${SUPABASE_URL}/functions/v1/${functionName}`
    : '';
}
