import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SUPABASE_URL = 'https://qmskozzidachccwbtejd.supabase.co';
const SESSION_STORAGE_KEY = 'live-city.social.session.v1';
const REQUEST_TIMEOUT_MS = 15_000;

let refreshInFlight: Promise<SocialSession> | null = null;

export type SocialSession = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string | null;
};

type AuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  user?: { id?: string; email?: string | null };
};

function publicKey() {
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!key) throw new Error('Configurazione Supabase non disponibile');
  return key;
}

function headers(accessToken?: string) {
  const key = publicKey();
  return {
    apikey: key,
    Authorization: `Bearer ${accessToken ?? key}`,
    'Content-Type': 'application/json',
  };
}

function sessionFromTokens(tokens: AuthTokenResponse): SocialSession {
  if (!tokens.access_token || !tokens.refresh_token || !tokens.user?.id) {
    throw new Error('Il link di accesso non contiene una sessione valida');
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    userId: tokens.user.id,
    email: tokens.user.email ?? null,
  };
}

export async function loadSocialSession() {
  // The social feature is designed for the native app.  Keeping access tokens
  // out of browser local storage makes the web preview safe and avoids relying
  // on SecureStore APIs that do not exist on web.
  if (Platform.OS === 'web') return null;
  const stored = await SecureStore.getItemAsync(SESSION_STORAGE_KEY);
  if (!stored) return null;
  try {
    const session = JSON.parse(stored) as Partial<SocialSession>;
    if (!session.accessToken || !session.refreshToken || !session.userId) {
      await clearSocialSession();
      return null;
    }
    return session as SocialSession;
  } catch {
    await clearSocialSession();
    return null;
  }
}

export async function saveSocialSession(session: SocialSession) {
  if (Platform.OS === 'web') return;
  await SecureStore.setItemAsync(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export async function clearSocialSession() {
  if (Platform.OS === 'web') return;
  await SecureStore.deleteItemAsync(SESSION_STORAGE_KEY);
}

export async function sendMagicLink(email: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      email,
      create_user: true,
      options: { emailRedirectTo: 'livecity://auth/callback' },
    }),
  });
  if (!response.ok) throw new Error('Non è stato possibile inviare il link di accesso');
}

async function refreshSocialSession(session: SocialSession): Promise<SocialSession> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ refresh_token: session.refreshToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await clearSocialSession();
        throw new Error('La sessione è scaduta: accedi di nuovo.');
      }
      const refreshed = sessionFromTokens(await response.json() as AuthTokenResponse);
      // Mutating the active object lets the current screen use the rotated
      // token immediately, without waiting for a navigation cycle.
      Object.assign(session, refreshed);
      await saveSocialSession(session);
      return session;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function authenticatedFetch(
  session: SocialSession,
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const request = (accessToken: string) => fetch(url, {
    ...options,
    headers: { ...headers(accessToken), ...(options.headers ?? {}) },
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let response = await request(session.accessToken);
  if (response.status !== 401) return response;
  const refreshed = await refreshSocialSession(session);
  response = await request(refreshed.accessToken);
  return response;
}

export async function sessionFromRedirect(url: string) {
  const fragment = url.split('#')[1] ?? '';
  const params = new URLSearchParams(fragment || url.split('?')[1] || '');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: headers(accessToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('La sessione di accesso non è valida');
  const user = (await response.json()) as { id: string; email?: string | null };
  const session = sessionFromTokens({
    access_token: accessToken,
    refresh_token: refreshToken,
    user,
  });
  await saveSocialSession(session);
  return session;
}

export async function socialRequest<T>(
  session: SocialSession,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await authenticatedFetch(session, `${SUPABASE_URL}/rest/v1/${path}`, options);
  const raw = await response.text();
  if (!response.ok) {
    const detail = raw ? `: ${raw}` : '';
    throw new Error(`Operazione social non riuscita${detail}`);
  }
  return raw ? (JSON.parse(raw) as T) : (undefined as T);
}

export async function startDirectThread(session: SocialSession, peerId: string) {
  const response = await authenticatedFetch(session, `${SUPABASE_URL}/rest/v1/rpc/start_direct_thread`, {
    method: 'POST',
    body: JSON.stringify({ peer_id: peerId }),
  });
  if (!response.ok) throw new Error('La chat richiede che vi seguiate entrambi');
  return (await response.json()) as string;
}

export async function acceptSocialFollow(session: SocialSession, requesterId: string) {
  const response = await authenticatedFetch(session, `${SUPABASE_URL}/rest/v1/rpc/accept_social_follow`, {
    method: 'POST',
    body: JSON.stringify({ requester_id: requesterId }),
  });
  if (!response.ok) throw new Error('La richiesta non è più disponibile');
}

export async function blockSocialUser(session: SocialSession, blockedId: string) {
  const response = await authenticatedFetch(session, `${SUPABASE_URL}/rest/v1/rpc/block_social_user`, {
    method: 'POST',
    body: JSON.stringify({ target_id: blockedId }),
  });
  if (!response.ok) throw new Error('Blocco non riuscito');
}

export async function reportSocialUser(
  session: SocialSession,
  reportedId: string,
  reason: string,
) {
  await socialRequest(session, 'user_reports', {
    method: 'POST',
    body: JSON.stringify({
      reporter_id: session.userId,
      reported_id: reportedId,
      reason,
    }),
  });
}
