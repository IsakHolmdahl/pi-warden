import { createHash } from "node:crypto";
import type { BackendSpec, TypeSafeOptions } from "pi-typesafe";
import { DEFAULT_BACKEND, backendHost, resolveBackend } from "pi-typesafe";

export type LocalBackend = "kev" | "laya";
export type RemoteBackend = BackendSpec;
/** The judgment backend: a pi-typesafe destination or one of pi-warden's local services. */
export type JudgmentBackend = RemoteBackend | LocalBackend;

/** A destination identity safe to persist with the user's consent; details remain represented only by its digest. */
export interface TypesafeConsentTarget {
  backend: string;
  host?: string;
  providerHost?: string;
  fingerprint: string;
}

export function isLocalBackend(backend: JudgmentBackend): backend is LocalBackend {
  return backend === "kev" || backend === "laya";
}

/** The judgment destination as the user config carries it, plus any refusal that keeps judgments off. */
export interface BackendSetting {
  /** The configured pi-typesafe destination or local service; undefined only when refused. */
  readonly typesafeBackend: JudgmentBackend | undefined;
  /** Why the configured value was refused: the once-per-session notice and `/warden status` quote it. */
  readonly backendRefusal: string | undefined;
}

/** What a raw `typesafeBackend` value resolves to: the spec judgments go to, or the refusal that turns them off. Exactly one is set. */
export type BackendResolution =
  | { readonly typesafeBackend: JudgmentBackend; readonly backendRefusal?: undefined }
  | { readonly typesafeBackend?: undefined; readonly backendRefusal: string };

/** Why no judge is available: consent not given, the backend refused, no key for the backend, a saved 401 or 403, or the request budget spent. */
export type JudgmentsOffReason = "no_consent" | "bad_backend" | "no_key" | "key_rejected" | "budget";

/**
 * Resolve a raw config value to the spec judgments go to, kept as written, or to the refusal that turns judgments off.
 * pi-typesafe validates registry names and endpoint specs. The two local choices bypass its registry; any other unknown
 * name or refused object is never silently mapped to the default backend.
 */
export function resolveJudgmentBackend(raw: unknown): BackendResolution {
  if (raw === undefined || raw === null) return { typesafeBackend: DEFAULT_BACKEND };
  if (raw === "kev" || raw === "laya") return { typesafeBackend: raw };
  try {
    resolveBackend(raw as BackendSpec);
  } catch (error) {
    return { backendRefusal: error instanceof Error ? error.message : String(error) };
  }
  return { typesafeBackend: raw as JudgmentBackend };
}

/** The name messages show for a backend: the registry name, or an endpoint's validated label. */
export function backendName(backend: JudgmentBackend | undefined): string {
  return backend === undefined || typeof backend === "string" ? backend ?? DEFAULT_BACKEND : resolveBackend(backend).label;
}

export function judgmentBackendHost(backend: JudgmentBackend | undefined): string {
  if (backend === "kev") return "127.0.0.1:3000";
  if (backend === "laya") return "127.0.0.1:8100";
  return backendHost(backend);
}

export function backendKeyEnv(backend: JudgmentBackend | undefined): string {
  if (backend === "kev") return "KEV_API_KEY";
  if (backend === "laya") return "LAYA_API_KEY";
  return resolveBackend(backend).keyEnv;
}

/** Whether the backend takes the TypeSafe key, the only one `/typesafe login` stores; true only for "typesafe". */
export function loginStoresKey(backend: JudgmentBackend | undefined): boolean {
  return backend === DEFAULT_BACKEND;
}

/** One phrase naming where judgments go — the label, the host, and the model sent — for consent text and status lines. */
export function describeBackend(backend: JudgmentBackend | undefined): string {
  if (backend === "kev" || backend === "laya") return `${backend} local service at ${judgmentBackendHost(backend)}`;
  const resolved = resolveBackend(backend);
  return `${resolved.label} at ${judgmentBackendHost(backend)}, model ${resolved.defaultModel ?? "none configured"}`;
}

function compareQueryPair([ak, av]: [string, string], [bk, bv]: [string, string]): number {
  return ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0;
}

function canonicalQuery(params: URLSearchParams, secrets: boolean): string[][] {
  const pairs = [...params].filter(([name]) => secretQueryName(name) === secrets);
  return pairs.sort(compareQueryPair);
}

function secretQueryName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, "");
  return ["key", "apikey", "accesskey", "token", "accesstoken", "secret", "clientsecret", "password", "passwd", "credential", "authorization", "auth", "signature", "sig"]
    .some(secret => normalized === secret || normalized.endsWith(secret));
}

function canonicalUrl(value: string) {
  const url = new URL(value);
  return {
    scheme: url.protocol, authority: url.host, path: url.pathname,
    query: canonicalQuery(url.searchParams, false),
    secrets: destinationFingerprint({ userinfo: [url.username, url.password], query: canonicalQuery(url.searchParams, true) }),
  };
}

function destinationFingerprint(fields: unknown): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function kevProviderOrigin(): { origin: string; insecure: boolean } | undefined {
  const baseUrl = process.env.KEV_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  try {
    const url = new URL(baseUrl);
    return url.origin === "null" ? undefined : { origin: url.origin, insecure: url.protocol === "http:" };
  } catch { return undefined; }
}

function kevConsentTarget(): TypesafeConsentTarget | undefined {
  const backend = process.env.KEV_BACKEND?.trim() || "openai";
  const baseUrl = process.env.KEV_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  try {
    const provider = canonicalUrl(baseUrl);
    return {
      backend: "kev", providerHost: provider.authority,
      fingerprint: destinationFingerprint({ kind: "kev", backend, provider, model: process.env.KEV_MODEL?.trim() || "kev-latest", openaiModel: process.env.KEV_OPENAI_MODEL?.trim() || "gpt-4o-mini" }),
    };
  } catch { return undefined; }
}

function remoteConsentTarget(backend: RemoteBackend): TypesafeConsentTarget {
  const resolved = resolveBackend(backend);
  const url = new URL(resolved.host);
  const name = resolved.name ?? "custom";
  const fingerprint = destinationFingerprint({
    kind: name, scheme: url.protocol, authority: url.host, path: resolved.path ?? "/v1/systemone",
    model: resolved.defaultModel, modelsPath: resolved.modelsPath ?? "/v1/models",
    modelsField: resolved.modelsField ?? "models", modelsIdField: resolved.modelsIdField,
    modelsVerifyKey: resolved.modelsVerifyKey,
  });
  return { backend: name, host: url.host, fingerprint };
}

/** The stable, sanitized destination saved alongside an interactive consent grant. */
export function consentTargetForBackend(backend: JudgmentBackend | undefined): TypesafeConsentTarget | undefined {
  if (backend === undefined) return undefined;
  if (backend === "kev") return kevConsentTarget();
  if (backend === "laya") {
    const host = judgmentBackendHost(backend);
    return { backend, host, fingerprint: destinationFingerprint({ kind: backend, scheme: "http:", authority: host, path: "/v1/systemone" }) };
  }
  return remoteConsentTarget(backend);
}

function sanitizeTargetHost(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) return undefined;
  try {
    const url = new URL(`https://${value}`);
    if (!url.host || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.host;
  } catch { return undefined; }
}

/** Parse only safe target fields from the user file; untrusted extra values are never carried into runtime config. */
export function parseConsentTarget(raw: unknown): TypesafeConsentTarget | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return undefined;
  if (value.backend === "kev") {
    const providerHost = sanitizeTargetHost(value.providerHost);
    return providerHost ? { backend: "kev", providerHost, fingerprint: value.fingerprint } : undefined;
  }
  if (typeof value.backend !== "string" || !value.backend.trim()) return undefined;
  const host = sanitizeTargetHost(value.host);
  return host ? { backend: value.backend, host, fingerprint: value.fingerprint } : undefined;
}

/** Match an explicit consent grant only to the exact effective destination fingerprint. */
export function consentTargetMatches(saved: TypesafeConsentTarget | undefined, current: TypesafeConsentTarget | undefined): boolean {
  return !!saved && !!current && /^[a-f0-9]{64}$/.test(saved.fingerprint)
    && saved.backend === current.backend && saved.host === current.host
    && saved.providerHost === current.providerHost && saved.fingerprint === current.fingerprint;
}

/** Adapt the consent text to the active backend by substituting the destination host. */
export function disclosureFor(backend: JudgmentBackend | undefined, disclosure: string): string {
  if (backend === undefined || backend === DEFAULT_BACKEND) return disclosure;
  const local = isLocalBackend(backend);
  const text = local ? disclosure.replace("With TypeSafe judgments enabled", "With local judgments enabled") : disclosure;
  const destination = text.replace(backendHost(DEFAULT_BACKEND), judgmentBackendHost(backend));
  if (backend !== "kev") return destination;
  const provider = kevProviderOrigin();
  const warning = provider?.insecure ? " This provider uses unencrypted HTTP transport." : "";
  return `${destination} Kev may forward judgment data (judgment state and questions) to its configured OpenAI-compatible model provider at ${provider?.origin ?? "unrecognized origin"}.${warning}`;
}

/**
 * Build the options forwarded to `createTypeSafe`.
 * The caller must gate on `authState({ backend }).usable` before calling `createTypeSafe`.
 */
export function judgeOptions(config: { maxRequests: number; timeoutMs: number; typesafeBackend: RemoteBackend }): TypeSafeOptions {
  return {
    maxRequests: config.maxRequests,
    timeoutMs: config.timeoutMs,
    ...(config.typesafeBackend === DEFAULT_BACKEND ? {} : { backend: config.typesafeBackend }),
  };
}
