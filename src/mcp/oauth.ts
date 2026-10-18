// OAuth 2.1 for MCP servers that require sign-in (MCP authorization spec): protected resource metadata
// (RFC 9728) → authorization server metadata (RFC 8414 / OpenID discovery) → client registration (a client id
// entered by the user, else Dynamic Client Registration, RFC 7591) → authorization code with PKCE S256 in a
// popup, resource indicator (RFC 8707), issuer check of the response (RFC 9207) → tokens, refreshed when they
// expire. The popup returns to this page; main.ts hands the code back through localStorage.

export interface TokenSet { access_token: string; refresh_token?: string; expires_at?: number; token_type?: string; client_id: string; token_endpoint: string; resource: string; issuer?: string }
interface AsMeta { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; scopes_supported?: string[]; code_challenge_methods_supported?: string[]; authorization_response_iss_parameter_supported?: boolean }

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function parseWwwAuthenticate(h: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const m of h.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  for (const m of h.matchAll(/([a-zA-Z_]+)=([^",\s]+)/g)) if (!(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2];
  return out;
}

async function getJson(url: string): Promise<any | null> {
  try { const r = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit" }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** Canonical resource URI of an MCP server (RFC 8707): no fragment, no trailing slash on a bare origin. */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.pathname === "/" && !u.search ? u.origin : u.href;
}

export async function discover(serverUrl: string, wwwAuthenticate: string | null): Promise<{ as: AsMeta; resource: string; scope?: string }> {
  const wa = parseWwwAuthenticate(wwwAuthenticate), u = new URL(serverUrl);
  const prmUrls = [wa.resource_metadata, `${u.origin}/.well-known/oauth-protected-resource${u.pathname !== "/" ? u.pathname : ""}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  let prm: any = null;
  for (const x of prmUrls) { prm = await getJson(x); if (prm) break; }
  const issuer: string = prm?.authorization_servers?.[0] ?? u.origin;
  const iu = new URL(issuer), path = iu.pathname === "/" ? "" : iu.pathname.replace(/\/$/, "");
  const asUrls = path
    ? [`${iu.origin}/.well-known/oauth-authorization-server${path}`, `${iu.origin}/.well-known/openid-configuration${path}`, `${iu.origin}${path}/.well-known/openid-configuration`]
    : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
  let as: AsMeta | null = null;
  for (const x of asUrls) { as = await getJson(x); if (as?.authorization_endpoint && as.token_endpoint) break; as = null; }
  if (!as) throw new Error(`No OAuth authorization server metadata found for ${issuer}`);
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes("S256")) throw new Error("The authorization server does not support PKCE S256 (required by MCP)");
  return { as, resource: prm?.resource ?? canonicalResource(serverUrl), scope: wa.scope ?? (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(" ") : undefined) };
}

const redirectUri = () => `${location.origin}${location.pathname}`;

async function register(as: AsMeta): Promise<string> {
  if (!as.registration_endpoint) throw new Error("The server needs a registered OAuth client: enter its client id in the server settings");
  const r = await fetch(as.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
    body: JSON.stringify({ client_name: "LUCID Forensic Workbench", redirect_uris: [redirectUri()], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "web" }),
  });
  if (!r.ok) throw new Error(`Client registration failed (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.client_id) throw new Error("Client registration returned no client id");
  return j.client_id;
}

async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<any> {
  const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form), credentials: "omit" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Token request failed: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`);
  return j;
}

/** Interactive sign-in. Must start from a click (the popup). */
export async function authorize(serverUrl: string, wwwAuthenticate: string | null, clientId?: string): Promise<TokenSet> {
  if (location.protocol !== "http:" && location.protocol !== "https:") throw new Error("Sign-in needs LUCID served over http(s) (the single-file copy cannot receive the OAuth redirect)");
  const popup = window.open("about:blank", "lucid-oauth", "width=520,height=720");
  if (!popup) throw new Error("The sign-in window was blocked: allow pop-ups for LUCID");
  try {
    const { as, resource, scope } = await discover(serverUrl, wwwAuthenticate);
    const cid = clientId || (await register(as));
    const verifier = rand(48), state = rand(16);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const q = new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: redirectUri(), code_challenge: challenge, code_challenge_method: "S256", state, resource });
    if (scope) q.set("scope", scope);
    localStorage.setItem(`lucid.oauth.pending.${state}`, "1");
    popup.location.href = `${as.authorization_endpoint}${as.authorization_endpoint.includes("?") ? "&" : "?"}${q}`;
    const result = await new Promise<{ code?: string; error?: string; iss?: string }>((ok, fail) => {
      const key = `lucid.oauth.result.${state}`;
      const check = () => { const v = localStorage.getItem(key); if (v) { localStorage.removeItem(key); cleanup(); ok(JSON.parse(v)); } };
      const iv = setInterval(() => { check(); if (popup.closed) { setTimeout(() => { check(); cleanup(); fail(new Error("The sign-in window was closed")); }, 400); } }, 300);
      const onStorage = (e: StorageEvent) => { if (e.key === key) check(); };
      const cleanup = () => { clearInterval(iv); removeEventListener("storage", onStorage); localStorage.removeItem(`lucid.oauth.pending.${state}`); };
      addEventListener("storage", onStorage);
    });
    if (result.error) throw new Error(`Sign-in refused: ${result.error}`);
    if (result.iss && result.iss !== as.issuer) throw new Error("The authorization response came from an unexpected issuer (RFC 9207)");
    if (!result.iss && as.authorization_response_iss_parameter_supported) throw new Error("The authorization response lacks the issuer (RFC 9207)");
    const t = await tokenRequest(as.token_endpoint, { grant_type: "authorization_code", code: result.code!, redirect_uri: redirectUri(), client_id: cid, code_verifier: verifier, resource });
    return { access_token: t.access_token, refresh_token: t.refresh_token, token_type: t.token_type, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined, client_id: cid, token_endpoint: as.token_endpoint, resource, issuer: as.issuer };
  } finally { try { popup.close(); } catch { /* gone */ } }
}

export async function refresh(t: TokenSet): Promise<TokenSet> {
  if (!t.refresh_token) throw new Error("Sign-in expired");
  const r = await tokenRequest(t.token_endpoint, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id, resource: t.resource });
  return { ...t, access_token: r.access_token, refresh_token: r.refresh_token ?? t.refresh_token, expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : undefined };
}

/**
 * In the sign-in popup (this page, opened by the authorization server's redirect): hand the result to the
 * LUCID tab that started it and close. Returns true when this page load was such a redirect.
 */
export function handleOAuthRedirect(): boolean {
  const q = new URLSearchParams(location.search), state = q.get("state");
  if (!state || !(q.has("code") || q.has("error"))) return false;
  try { if (!localStorage.getItem(`lucid.oauth.pending.${state}`)) return false; } catch { return false; }
  localStorage.setItem(`lucid.oauth.result.${state}`, JSON.stringify({ code: q.get("code") ?? undefined, error: q.get("error") ?? undefined, iss: q.get("iss") ?? undefined }));
  document.body.textContent = "Signed in — you can close this window.";
  setTimeout(() => window.close(), 300);
  return true;
}
