import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeIntegrationError } from "pi-typesafe";
import type { Questions, SystemOneRequest, SystemOneResult, TypeSafe } from "pi-typesafe";
import { consentTargetForBackend } from "./backend.js";
import type { LocalBackend } from "./backend.js";

export interface LocalBackendOptions {
  backend: LocalBackend;
  runProcess: (command: string, args: string[]) => Promise<void>;
  fetch: typeof globalThis.fetch;
  readinessTimeoutMs: number;
  requestTimeoutMs?: number;
}

export interface LocalBackendClient {
  evaluate<Q extends Questions>(request: SystemOneRequest<Q>, options?: { signal?: AbortSignal; onRequestStart?: () => void; requestTimeoutMs?: number }): Promise<SystemOneResult<Q> & { elapsedMs: number }>;
}

export const localJudgmentClientBrand = Symbol("localJudgmentClient");

export interface LocalJudgmentClient {
  readonly [localJudgmentClientBrand]: true;
  evaluate<Q extends Questions>(request: SystemOneRequest<Q>, options?: { signal?: AbortSignal; requestTimeoutMs?: number }): Promise<SystemOneResult<Q> & { elapsedMs: number }>;
  getUsage: TypeSafe["getUsage"];
  getSpend(): { caps: { maxRequests?: number } };
}

const packageDir = dirname(fileURLToPath(import.meta.url));
const composePath = resolve(packageDir, "../docker/compose.yaml");
const composeEnvPath = resolve(packageDir, "../docker/compose.env");
const baseUrl = (backend: LocalBackend) => `http://127.0.0.1:${backend === "kev" ? 3000 : 8100}`;
const healthUrl = (backend: LocalBackend) => `${baseUrl(backend)}/health`;
const pause = (ms: number) => new Promise<void>(resolvePause => setTimeout(resolvePause, ms));

async function waitUntilReady(backend: LocalBackend, fetcher: typeof fetch, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(healthUrl(backend), {
        headers: localHeaders(backend),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (response.ok) return;
    } catch { /* The listener is not ready yet. */ }
    await pause(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new TypeSafeIntegrationError("timeout", `${backend} did not become ready within ${timeoutMs} ms.`);
}

function effectiveServiceConfig(backend: LocalBackend): Record<string, string> {
  if (backend === "kev") return {
    backend: process.env.KEV_BACKEND || "openai", model: process.env.KEV_MODEL || "kev-latest",
    baseUrl: process.env.KEV_OPENAI_BASE_URL || "https://api.openai.com/v1",
    providerModel: process.env.KEV_OPENAI_MODEL || "gpt-4o-mini",
    providerKey: process.env.KEV_OPENAI_API_KEY || "", serviceKey: process.env.KEV_API_KEY || "",
  };
  return {
    device: process.env.LAYA_DEVICE || "cpu", serviceKey: process.env.LAYA_API_KEY || "",
    preload: process.env.LAYA_PRELOAD || "", models: process.env.LAYA_MODELS || "",
    threads: process.env.LAYA_THREADS || "", hfToken: process.env.HF_TOKEN || "",
  };
}

function composeProjectName(backend: LocalBackend): string {
  const configHash = createHash("sha256").update(JSON.stringify(effectiveServiceConfig(backend))).digest("hex");
  const identity = { backend, target: consentTargetForBackend(backend), configHash };
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
  return `pi-warden-local-backends-${digest}`;
}

function composeArgs(backend: LocalBackend, timeoutMs: number): string[] {
  return ["compose", "--project-name", composeProjectName(backend), "--env-file", composeEnvPath, "-f", composePath, "up", "-d", "--wait", "--wait-timeout", String(Math.ceil(timeoutMs / 1000)), backend];
}

function localHeaders(backend: LocalBackend): Headers {
  const headers = new Headers();
  const key = localKey(backend);
  if (key) headers.set("authorization", `Bearer ${key}`);
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isProbabilityMap(value: unknown, keys: string[]): boolean {
  return isRecord(value) && hasExactKeys(value, keys) && Object.values(value).every(isProbability);
}

function matchesJson(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((item, index) => matchesJson(actual[index], item));
  if (!isRecord(actual) || !isRecord(expected)) return false;
  const keys = Object.keys(expected);
  return hasExactKeys(actual, keys) && keys.every(key => matchesJson(actual[key], expected[key]));
}

function isValidAnswer(question: Questions[string], value: unknown): boolean {
  if (!isRecord(value) || value.type !== question.type) return false;
  if (question.type === "noul") return isProbability(value.noul);
  if (question.type === "choice") {
    const choices = Object.keys(question.criteria);
    return typeof value.choice === "string" && choices.includes(value.choice)
      && isProbability(value.confidence) && isProbabilityMap(value.probabilities, choices);
  }
  const scores = question.criteria.map((_criterion, index) => String(index));
  const legend = value.legend;
  return typeof value.score === "number" && Number.isFinite(value.score)
    && value.score >= 0 && value.score <= question.criteria.length - 1
    && isProbability(value.confidence) && isProbabilityMap(value.probabilities, scores)
    && isRecord(legend) && hasExactKeys(legend, scores)
    && scores.every((score, index) => matchesJson(legend[score], question.criteria[index]));
}

function isValidResult<Q extends Questions>(value: unknown, questions: Q): value is SystemOneResult<Q> {
  if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim()) return false;
  const usage = value.usage;
  if (!isRecord(usage) || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return false;
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return false;
  if (usage.input_tokens < 0 || usage.output_tokens < 0) return false;
  const answers = value.answers;
  if (!isRecord(answers) || !hasExactKeys(answers, Object.keys(questions))) return false;
  return Object.entries(questions).every(([id, question]) => isValidAnswer(question, answers[id]));
}

function invalidResponse(backend: LocalBackend): TypeSafeIntegrationError {
  return new TypeSafeIntegrationError("response", `${backend} returned an invalid System One response.`);
}

function localKey(backend: LocalBackend): string | undefined {
  const key = process.env[backend === "kev" ? "KEV_API_KEY" : "LAYA_API_KEY"];
  return key || undefined;
}

function createStartup(backend: LocalBackend, runProcess: LocalBackendOptions["runProcess"], fetcher: typeof fetch, readinessTimeoutMs: number): () => Promise<void> {
  let startup: Promise<void> | undefined;
  return () => {
    if (startup) return startup;
    const deadline = Date.now() + readinessTimeoutMs;
    startup = runProcess("docker", composeArgs(backend, readinessTimeoutMs))
      .then(() => waitUntilReady(backend, fetcher, Math.max(1, deadline - Date.now())))
      .catch(error => { startup = undefined; throw error; });
    return startup;
  };
}

function waitForStartup(startup: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return startup;
  return new Promise<void>((resolveStartup, rejectStartup) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); rejectStartup(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    startup.then(() => { cleanup(); resolveStartup(); }, error => { cleanup(); rejectStartup(error); });
  });
}

async function readLocalResult<Q extends Questions>(response: Response, backend: LocalBackend, questions: Q): Promise<SystemOneResult<Q>> {
  let result: unknown;
  try { result = await response.json(); }
  catch { throw invalidResponse(backend); }
  if (!isValidResult(result, questions)) throw invalidResponse(backend);
  return result;
}

async function evaluateLocalRequest<Q extends Questions>(
  options: LocalBackendOptions,
  ensureStarted: () => Promise<void>,
  requestTimeoutMs: number,
  request: SystemOneRequest<Q>,
  requestOptions?: { signal?: AbortSignal; onRequestStart?: () => void; requestTimeoutMs?: number },
): Promise<SystemOneResult<Q> & { elapsedMs: number }> {
  const { backend, fetch: fetcher } = options;
  const startedAt = Date.now();
  requestOptions?.signal?.throwIfAborted();
  await waitForStartup(ensureStarted(), requestOptions?.signal);
  requestOptions?.signal?.throwIfAborted();
  const timeoutMs = requestOptions?.requestTimeoutMs ?? requestTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeSafeIntegrationError("configuration", "requestTimeoutMs must be positive.");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = requestOptions?.signal ? AbortSignal.any([requestOptions.signal, timeout]) : timeout;
  const headers = localHeaders(backend);
  headers.set("content-type", "application/json");
  requestOptions?.onRequestStart?.();
  const response = await fetcher(`${baseUrl(backend)}/v1/systemone`, { method: "POST", headers, body: JSON.stringify(request), signal });
  if (!response.ok) throw new TypeSafeIntegrationError("http", `${backend} request failed with HTTP ${response.status}.`, response.status);
  const result = await readLocalResult(response, backend, request.questions);
  return { ...result, elapsedMs: Date.now() - startedAt };
}

export function createLocalBackend(options: LocalBackendOptions): LocalBackendClient {
  const { backend, runProcess, fetch: fetcher, readinessTimeoutMs } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) throw new RangeError("readinessTimeoutMs must be positive.");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new RangeError("requestTimeoutMs must be positive.");
  const ensureStarted = createStartup(backend, runProcess, fetcher, readinessTimeoutMs);
  return { evaluate: (request, requestOptions) => evaluateLocalRequest(options, ensureStarted, requestTimeoutMs, request, requestOptions) };
}

/** Adapt a local transport to the shared TypeSafe judgment usage and request-budget contract. */
export function createLocalJudgmentClient(runtime: LocalBackendClient, maxRequests: number): LocalJudgmentClient {
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) throw new TypeSafeIntegrationError("configuration", "maxRequests must be a positive safe integer.");
  const usage = { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  const evaluate = async <Q extends Questions>(request: SystemOneRequest<Q>, options?: { signal?: AbortSignal; requestTimeoutMs?: number }) => {
    if (usage.requestsStarted >= maxRequests) throw localBudgetError(maxRequests);
    let requestStarted = false;
    const onRequestStart = () => {
      if (usage.requestsStarted >= maxRequests) throw localBudgetError(maxRequests);
      usage.requestsStarted++;
      requestStarted = true;
    };
    try {
      const result = await runtime.evaluate(request, { ...(options?.signal ? { signal: options.signal } : {}), ...(options?.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }), onRequestStart });
      usage.requestsSucceeded++;
      usage.inputTokens += result.usage.input_tokens;
      usage.outputTokens += result.usage.output_tokens;
      return result;
    } catch (error) {
      if (requestStarted) usage.requestsFailed++;
      throw error;
    }
  };
  return { [localJudgmentClientBrand]: true, evaluate, getUsage: () => usage, getSpend: () => ({ caps: { maxRequests } }) };
}

function localBudgetError(maxRequests: number): TypeSafeIntegrationError {
  return new TypeSafeIntegrationError("budget", `Local judgment request limit reached (${maxRequests} attempts per client instance).`);
}
