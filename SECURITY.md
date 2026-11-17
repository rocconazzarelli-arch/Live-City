# Security policy

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, leaked credentials, personal
location data, authentication bypasses, or database access problems.

Use GitHub's private vulnerability reporting flow instead:

1. Open the repository's **Security** tab.
2. Select **Advisories**.
3. Select **Report a vulnerability**.

Include the affected component, reproduction steps, impact, and a minimal proof
of concept. Do not include real user location records, payment data, passwords,
API keys, or Supabase service-role credentials.

## Supported version

Security fixes currently target the latest commit on `main`.

## Secrets and production access

- Keep local `.env` files out of Git.
- Store production Edge Function secrets in Supabase Secrets.
- Never expose Supabase service-role keys or provider credentials in the mobile
  bundle, screenshots, issues, logs, or pull requests.
- Rotate a credential immediately if it is accidentally disclosed.
