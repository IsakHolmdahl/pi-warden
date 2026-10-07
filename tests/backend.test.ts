import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { DECISIONS_BACKENDS } from "pi-typesafe";
import { backendName, consentTargetForBackend, consentTargetMatches, describeBackend, disclosureFor, judgeOptions, loginStoresKey, parseConsentTarget, resolveJudgmentBackend } from "../src/backend.js";

const gateway = { label: "Acme judge gateway", host: "https://gw.acme.example", path: "/judge/v1/decide", keyEnv: "ACME_JUDGE_KEY", defaultModel: "jev-1.13" };
const withKevTarget = (url: string, model = "gpt-4o-mini", backend = "openai", kevModel = "kev-latest") => {
  const names = ["KEV_OPENAI_BASE_URL", "KEV_OPENAI_MODEL", "KEV_BACKEND", "KEV_MODEL"];
  const saved = names.map(name => process.env[name]);
  [process.env.KEV_OPENAI_BASE_URL, process.env.KEV_OPENAI_MODEL, process.env.KEV_BACKEND, process.env.KEV_MODEL] = [url, model, backend, kevModel];
  try { return consentTargetForBackend("kev"); }
  finally { names.forEach((name, index) => saved[index] === undefined ? delete process.env[name] : process.env[name] = saved[index]); }
};

test("resolveJudgmentBackend: names pass through, junk is refused instead of silently mapped to typesafe", () => {
  assert.deepEqual(resolveJudgmentBackend("typesafe"), { typesafeBackend: "typesafe" });
  assert.deepEqual(resolveJudgmentBackend("openrouter"), { typesafeBackend: "openrouter" });
  assert.deepEqual(resolveJudgmentBackend("commandcode"), { typesafeBackend: "commandcode" });
  assert.deepEqual(resolveJudgmentBackend("kev"), { typesafeBackend: "kev" });
  assert.deepEqual(resolveJudgmentBackend("laya"), { typesafeBackend: "laya" });
  assert.deepEqual(resolveJudgmentBackend(undefined), { typesafeBackend: "typesafe" });
  assert.deepEqual(resolveJudgmentBackend(null), { typesafeBackend: "typesafe" });
  for (const junk of ["", "azure", 42]) {
    const resolution = resolveJudgmentBackend(junk);
    assert.equal(resolution.typesafeBackend, undefined, `${JSON.stringify(junk)} must not fall back to typesafe`);
    assert.ok(resolution.backendRefusal, "the refusal message is kept for the notice and the status line");
  }
  assert.match(resolveJudgmentBackend("azure").backendRefusal!, /Unknown judgment backend "azure"/);
});

test("resolveJudgmentBackend: an endpoint object is kept as written, and one pi-typesafe refuses is refused here too", () => {
  assert.equal(resolveJudgmentBackend(gateway).typesafeBackend, gateway, "the object passes through unchanged; pi-typesafe validates it on every call");
  const bad = resolveJudgmentBackend({ label: "Acme judge gateway", host: "http://gw.acme.example", keyEnv: "ACME_JUDGE_KEY" });
  assert.equal(bad.typesafeBackend, undefined);
  assert.match(bad.backendRefusal!, /absolute https/);
});

test("loginStoresKey is true only for typesafe", () => {
  assert.equal(loginStoresKey("typesafe"), true);
  assert.equal(loginStoresKey("openrouter"), false);
  assert.equal(loginStoresKey("commandcode"), false);
  assert.equal(loginStoresKey(gateway), false, "an endpoint object never gets the TypeSafe login store");
});

test("backendName shows the registry name or the endpoint label", () => {
  assert.equal(backendName("typesafe"), "typesafe");
  assert.equal(backendName("openrouter"), "openrouter");
  assert.equal(backendName(gateway), "Acme judge gateway");
});

test("describeBackend names the label, host, and model sent", () => {
  assert.equal(describeBackend("typesafe"), "TypeSafe at api.typesafe.ai, model jev-latest");
  assert.equal(describeBackend("commandcode"), "Command Code at api.commandcode.ai, model typesafe/jev");
  assert.equal(describeBackend(gateway), "Acme judge gateway at gw.acme.example, model jev-1.13");
});

test("disclosureFor: typesafe returns the original text unchanged", () => {
  const text = "pi-warden sends to api.typesafe.ai: your latest request";
  assert.equal(disclosureFor("typesafe", text), text);
});

test("disclosureFor: openrouter replaces the host in the disclosure", () => {
  const text = "pi-warden sends to api.typesafe.ai: your latest request";
  const result = disclosureFor("openrouter", text);
  assert.match(result, /openrouter\.ai/);
  assert.doesNotMatch(result, /api\.typesafe\.ai/);
  assert.equal(result, "pi-warden sends to openrouter.ai: your latest request");
});

test("disclosureFor: an endpoint object replaces the host with its own", () => {
  const text = "pi-warden sends to api.typesafe.ai: your latest request";
  assert.equal(disclosureFor(gateway, text), "pi-warden sends to gw.acme.example: your latest request");
});

test("Kev disclosure names its sanitized provider origin and warns when it uses HTTP", () => {
  const saved = process.env.KEV_OPENAI_BASE_URL;
  const text = "With TypeSafe judgments enabled, pi-warden sends to api.typesafe.ai: your latest request";
  try {
    process.env.KEV_OPENAI_BASE_URL = "https://user:secret@model.example:8443/v1?api_key=private-key";
    const secure = disclosureFor("kev", text);
    assert.match(secure, /Kev.{0,100}forward.{0,80}judgment data/i);
    assert.doesNotMatch(secure, /user|secret|private-key|model\.example:8443\/v1/i);
    process.env.KEV_OPENAI_BASE_URL = "http://user:secret@model.example:8443/v1?api_key=private-key";
    const insecure = disclosureFor("kev", text);
    assert.deepEqual([
      /https:\/\/model\.example:8443/.test(secure),
      /http:\/\/model\.example:8443/.test(insecure),
      /unencrypted|insecure|cleartext/i.test(insecure),
    ], [true, true, true], "disclosure must show sanitized scheme/origin and warn for HTTP providers");
    assert.equal(consentTargetForBackend("kev")?.providerHost, "model.example:8443");
  } finally { if (saved === undefined) delete process.env.KEV_OPENAI_BASE_URL; else process.env.KEV_OPENAI_BASE_URL = saved; }
});

test("consent targets stably identify local, builtin, and custom destinations without storing paths or keys", () => {
  assert.equal(consentTargetForBackend("typesafe")?.host, "api.typesafe.ai");
  assert.equal(consentTargetForBackend("openrouter")?.host, "openrouter.ai");
  assert.equal(consentTargetForBackend("laya")?.host, "127.0.0.1:8100");
  const custom = consentTargetForBackend(gateway);
  assert.equal(custom?.backend, "custom");
  assert.equal(custom?.host, "gw.acme.example");
  assert.deepEqual(parseConsentTarget({ ...custom, key: "secret", path: "/private" }), custom);
  assert.equal(parseConsentTarget({ backend: custom?.backend, host: custom?.host }), undefined, "explicit targets require a fingerprint");
  assert.equal(consentTargetMatches({ ...custom!, fingerprint: "0".repeat(64) }, custom), false, "same host needs the matching fingerprint");
  assert.equal(parseConsentTarget({ backend: "kev", providerHost: "user:secret@model.example" }), undefined);
  assert.equal(parseConsentTarget({ backend: "kev", providerHost: "model.example/v1?key=private" }), undefined);
  assert.equal(consentTargetMatches({ backend: "kev", providerHost: "old.example", fingerprint: "0".repeat(64) }, consentTargetForBackend("laya")), false);
});

test("Kev consent fingerprint changes with scheme, route, query, and provider model on one host", () => {
  const baseline = withKevTarget("https://model.fixture.invalid/v1?tenant=alpha");
  const variants = [
    withKevTarget("http://model.fixture.invalid/v1?tenant=alpha"),
    withKevTarget("https://model.fixture.invalid/v2?tenant=alpha"),
    withKevTarget("https://model.fixture.invalid/v1?tenant=beta"),
    withKevTarget("https://model.fixture.invalid/v1?tenant=alpha", "gpt-fixture-next"),
    withKevTarget("https://model.fixture.invalid/v1?tenant=alpha", "gpt-4o-mini", "azure-compatible"),
    withKevTarget("https://model.fixture.invalid/v1?tenant=alpha", "gpt-4o-mini", "openai", "kev-fixture-next"),
  ];
  assert.ok(baseline);
  for (const changed of variants) {
    assert.notDeepEqual(changed, baseline, "same-host destination change needs a distinct consent target");
    assert.equal(consentTargetMatches(baseline, changed), false);
  }
});

test("custom consent fingerprint changes with endpoint and model-list settings", () => {
  const baseline = consentTargetForBackend(gateway);
  const changedPath = consentTargetForBackend({ ...gateway, path: "/judge/private-route" });
  const changedModel = consentTargetForBackend({ ...gateway, defaultModel: "jev-fixture-next" });
  const changedModelsRoute = consentTargetForBackend({ ...gateway, modelsPath: "/judge/models" });
  const changedModelsField = consentTargetForBackend({ ...gateway, modelsField: "items" });
  for (const changed of [changedPath, changedModel, changedModelsRoute, changedModelsField]) {
    assert.notDeepEqual(changed, baseline, "effective custom endpoint settings require new consent");
    assert.equal(consentTargetMatches(baseline, changed), false);
  }
  for (const target of [baseline, changedPath, changedModel, changedModelsRoute, changedModelsField]) {
    const serialized = JSON.stringify(target);
    assert.doesNotMatch(serialized, /\/judge\/(?:v1\/decide|private-route|models)|fixture-api-key/);
  }
});

test("Kev consent target persists only safe comparison data, never URL secrets or destination text", () => {
  const url = "https://url-user-fixture:url-password-fixture@model.fixture.invalid/private/path-fixture?tenant=query-fixture&api_key=url-api-key-fixture";
  const target = withKevTarget(url);
  const serialized = JSON.stringify(target);
  assert.deepEqual(Object.keys(target!).sort(), ["backend", "fingerprint", "providerHost"]);
  assert.match(target!.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(serialized, /url-user-fixture|url-password-fixture|\/private\/path-fixture|tenant=query-fixture|url-api-key-fixture/);
});

test("Kev identity canonicalizes query order but fingerprints URL credentials and secret query changes", () => {
  const first = withKevTarget("https://url-user-one:url-password-one@model.fixture.invalid/v1?tenant=alpha&api_key=url-key-one");
  const reordered = withKevTarget("https://url-user-one:url-password-one@model.fixture.invalid/v1?api_key=url-key-one&tenant=alpha");
  const changedSecret = withKevTarget("https://url-user-one:url-password-one@model.fixture.invalid/v1?tenant=alpha&api_key=url-key-two");
  const changedUserinfo = withKevTarget("https://url-user-two:url-password-two@model.fixture.invalid/v1?tenant=alpha&api_key=url-key-one");
  assert.equal(first?.fingerprint, reordered?.fingerprint);
  const serialized = JSON.stringify([first, changedSecret, changedUserinfo]);
  assert.doesNotMatch(serialized, /url-user-one|url-user-two|url-password-one|url-password-two|url-key-one|url-key-two/);
  assert.deepEqual([
    changedSecret?.fingerprint !== first?.fingerprint,
    changedUserinfo?.fingerprint !== first?.fingerprint,
  ], [true, true], "secret query values and URL userinfo must both affect identity");
});

test("judgeOptions: typesafe backend omits the backend field", () => {
  const opts = judgeOptions({ maxRequests: 10, timeoutMs: 3000, typesafeBackend: "typesafe" });
  assert.equal(opts.maxRequests, 10);
  assert.equal(opts.timeoutMs, 3000);
  assert.equal("backend" in opts, false, "default backend should not be forwarded");
});

test("judgeOptions: commandcode and openrouter are forwarded as names", () => {
  assert.equal((judgeOptions({ maxRequests: 10, timeoutMs: 3000, typesafeBackend: "commandcode" }) as Record<string, unknown>).backend, "commandcode");
  assert.equal((judgeOptions({ maxRequests: 10, timeoutMs: 3000, typesafeBackend: "openrouter" }) as Record<string, unknown>).backend, "openrouter");
});

test("judgeOptions: an endpoint object reaches createTypeSafe unchanged", () => {
  const opts = judgeOptions({ maxRequests: 10, timeoutMs: 3000, typesafeBackend: gateway });
  assert.equal(opts.backend, gateway);
});

test("backend hosts come from pi-typesafe's registry, not a local copy", () => {
  for (const backend of ["typesafe", "openrouter", "commandcode"] as const) {
    const host = new URL(DECISIONS_BACKENDS[backend].host).host;
    assert.match(describeBackend(backend), new RegExp(host.replace(/[.]/g, "\\.")));
  }
});

const systemOneRequest = {
  state: { task: "offline backend test" },
  questions: { decision: { type: "noul" as const, instructions: "Should this action proceed?" } },
  model: "local-test-model",
};
const systemOneResult = {
  model: "local-test-model",
  answers: { decision: { type: "noul", noul: 0.2 } },
  usage: { input_tokens: 13, output_tokens: 2 },
};

type LocalRuntimeRequestStartContract = {
  evaluate(request: typeof systemOneRequest, options?: { signal?: AbortSignal; onRequestStart?: () => void }): Promise<unknown>;
};
type LocalJudgmentClientContract = {
  evaluate(request: typeof systemOneRequest): Promise<unknown>;
  getUsage(): { requestsStarted: number };
};
type LocalJudgmentClientFactory = (runtime: LocalRuntimeRequestStartContract, maxRequests: number) => LocalJudgmentClientContract;

async function localRuntime(backend: "kev" | "laya", runProcess: (command: string, args: string[]) => Promise<void>, fetch: typeof globalThis.fetch) {
  const runtime = await import("../src/local-backend.js");
  return runtime.createLocalBackend({ backend, runProcess, fetch, readinessTimeoutMs: 1000 });
}

async function composeProjectName(): Promise<string> {
  let args: string[] = [];
  const judge = await localRuntime("kev", async (_command, value) => { args = value; }, async (_input, init) =>
    init?.method === "POST" ? Response.json(systemOneResult) : new Response(null, { status: 200 }));
  await judge.evaluate(systemOneRequest);
  const flag = args.findIndex(arg => arg === "-p" || arg === "--project-name");
  assert.ok(flag >= 0, "Compose must set an explicit project name");
  return args[flag + 1]!;
}

function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(value => { clearTimeout(timer); resolve({ value }); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

function recordingLocalFetch(events: string[]) {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let readinessChecks = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    if (init?.method !== "POST") {
      readinessChecks++;
      events.push("ready");
      return new Response(null, { status: readinessChecks === 1 ? 503 : 200 });
    }
    events.push("request");
    bodies.push(JSON.parse(String(init.body)));
    assert.equal(new Headers(init.headers).get("authorization"), null, "a local service needs no Jev key");
    return Response.json(systemOneResult);
  };
  return { fetch, urls, bodies, readinessChecks: () => readinessChecks };
}

async function runLocalRoute(backend: "kev" | "laya") {
  const events: string[] = [];
  const composeCalls: Array<{ command: string; args: string[] }> = [];
  const runProcess = async (command: string, args: string[]) => { composeCalls.push({ command, args }); events.push("compose"); };
  const keyEnv = backend === "kev" ? "KEV_API_KEY" : "LAYA_API_KEY";
  const savedKey = process.env[keyEnv];
  delete process.env[keyEnv];
  try {
    const recorded = recordingLocalFetch(events);
    const judge = await localRuntime(backend, runProcess, recorded.fetch);
    const result = await judge.evaluate(systemOneRequest);
    return { backend, events, composeCalls, ...recorded, result };
  } finally { if (savedKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = savedKey; }
}

async function assertLocalBackendRoutes(backend: "kev" | "laya") {
  const { events, composeCalls, urls, bodies, readinessChecks, result } = await runLocalRoute(backend);
  const port = backend === "kev" ? 3000 : 8100;
  const other = backend === "kev" ? "laya" : "kev";
  assert.equal(composeCalls.length, 1, "one lazy Compose start serves the request");
  assert.equal(composeCalls[0]!.command, "docker");
  assert.ok(composeCalls[0]!.args.includes("compose") && composeCalls[0]!.args.includes("up"));
  assert.ok(composeCalls[0]!.args.includes(backend) && !composeCalls[0]!.args.includes(other));
  const composeFile = composeCalls[0]!.args[composeCalls[0]!.args.indexOf("-f") + 1];
  assert.match(composeFile ?? "", /docker[/\\]compose\.ya?ml$/);
  const envFileFlag = composeCalls[0]!.args.indexOf("--env-file");
  assert.ok(envFileFlag >= 0, "Compose must use an explicit package-owned env file");
  assert.ok(envFileFlag < composeCalls[0]!.args.indexOf("up"), "the explicit env file must be selected before up");
  assert.equal(composeCalls[0]!.args[envFileFlag + 1], resolve(import.meta.dirname, "../docker/compose.env"));
  assert.deepEqual(events, ["compose", "ready", "ready", "request"], "request waits for readiness");
  assert.equal(readinessChecks(), 2);
  assert.ok(urls.includes(`http://127.0.0.1:${port}/health`));
  assert.equal(urls.filter(url => url.endsWith("/v1/systemone")).length, 1);
  assert.match(urls.at(-1)!, new RegExp(`127\\.0\\.0\\.1:${port}/v1/systemone$`));
  assert.deepEqual(bodies, [systemOneRequest]);
  assert.deepEqual({ model: result.model, answers: result.answers, usage: result.usage }, systemOneResult);
}

test("Kev starts only its packaged service, waits for readiness, and routes one System One request", async () => {
  await assertLocalBackendRoutes("kev");
});

test("Laya starts only its packaged service, waits for readiness, and routes one System One request", async () => {
  await assertLocalBackendRoutes("laya");
});

test("Compose startup uses a hashed explicit pi-warden project name", async () => {
  const name = await composeProjectName();
  assert.match(name, /^pi-warden-local-backends-[a-f0-9]{12,64}$/);
});

test("Kev Compose project names are stable per effective service config and hide config secrets", async () => {
  const names = ["KEV_OPENAI_BASE_URL", "KEV_OPENAI_MODEL", "KEV_MODEL", "KEV_OPENAI_API_KEY", "KEV_API_KEY"];
  const saved = names.map(name => process.env[name]);
  try {
    Object.assign(process.env, { KEV_OPENAI_BASE_URL: "https://provider-user-one:provider-password-one@provider-one.fixture.invalid/v1", KEV_OPENAI_MODEL: "model-one", KEV_MODEL: "kev-one", KEV_OPENAI_API_KEY: "provider-secret-one", KEV_API_KEY: "service-secret-one" });
    const baseline = await composeProjectName();
    assert.equal(await composeProjectName(), baseline);
    process.env.KEV_OPENAI_BASE_URL = "https://provider-two.fixture.invalid/v1";
    const changedProvider = await composeProjectName();
    process.env.KEV_OPENAI_BASE_URL = "https://provider-user-one:provider-password-one@provider-one.fixture.invalid/v1";
    process.env.KEV_OPENAI_API_KEY = "provider-secret-two";
    const changedSecret = await composeProjectName();
    assert.doesNotMatch([baseline, changedProvider, changedSecret].join(" "), /provider-user-one|provider-password-one|provider-secret-one|provider-secret-two|service-secret-one/);
    assert.deepEqual([changedProvider !== baseline, changedSecret !== baseline], [true, true], "provider config and secret changes must each affect the project name");
  } finally { names.forEach((name, index) => saved[index] === undefined ? delete process.env[name] : process.env[name] = saved[index]!); }
});

test("a local health 404 is not ready; polling continues until 2xx before POST", async () => {
  const events: string[] = [];
  let checks = 0;
  const judge = await localRuntime("kev", async () => {}, async (_input, init) => {
    if (init?.method === "POST") { events.push("request"); return Response.json(systemOneResult); }
    checks++;
    events.push("health");
    return new Response(null, { status: checks === 1 ? 404 : 200 });
  });
  await judge.evaluate(systemOneRequest);
  assert.deepEqual(events, ["health", "health", "request"]);
});

async function assertLocalHealthKey(backend: "kev" | "laya", keyEnv: "KEV_API_KEY" | "LAYA_API_KEY") {
  const savedKey = process.env[keyEnv];
  const savedTypesafeKey = process.env.TYPESAFE_API_KEY;
  const key = `offline-${backend}-health-key`;
  process.env[keyEnv] = key;
  process.env.TYPESAFE_API_KEY = "offline-typesafe-health-key";
  const authorization: Array<string | null> = [];
  try {
    const judge = await localRuntime(backend, async () => {}, async (_input, init) => {
      authorization.push(new Headers(init?.headers).get("authorization"));
      return init?.method === "POST" ? Response.json(systemOneResult) : new Response(null, { status: 200 });
    });
    await judge.evaluate(systemOneRequest);
    assert.deepEqual(authorization, [`Bearer ${key}`, `Bearer ${key}`]);
  } finally {
    if (savedKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = savedKey;
    if (savedTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedTypesafeKey;
  }
}

test("health and request use only each optional local key, never TYPESAFE_API_KEY", async () => {
  await assertLocalHealthKey("kev", "KEV_API_KEY");
  await assertLocalHealthKey("laya", "LAYA_API_KEY");
});

const malformedSystemOneResponses: unknown[] = [
  { ...systemOneResult, answers: { decision: { type: "noul", noul: 1.1 } } },
  { ...systemOneResult, answers: { decision: { type: "judged", judgment: "yes" } } },
  { ...systemOneResult, usage: undefined },
  { ...systemOneResult, model: undefined },
];

async function localResponseWasAccepted(body: unknown): Promise<boolean> {
  const judge = await localRuntime("kev", async () => {}, async (_input, init) =>
    init?.method === "POST" ? Response.json(body) : new Response(null, { status: 200 }));
  try { await judge.evaluate(systemOneRequest); return true; } catch { return false; }
}

test("malformed System One response content is rejected instead of cast through", async () => {
  const accepted = await Promise.all(malformedSystemOneResponses.map(localResponseWasAccepted));
  assert.deepEqual(accepted, [false, false, false, false]);
});

test("local Authorization uses only the selected service's optional key", async () => {
  const savedKev = process.env.KEV_API_KEY;
  const savedLaya = process.env.LAYA_API_KEY;
  process.env.KEV_API_KEY = "local-kev-test-key";
  process.env.LAYA_API_KEY = "unmatched-laya-test-key";
  try {
    let authorization: string | null = null;
    const judge = await localRuntime("kev", async () => {}, async (_input, init) => {
      if (init?.method === "POST") authorization = new Headers(init.headers).get("authorization");
      return init?.method === "POST" ? Response.json(systemOneResult) : new Response(null, { status: 200 });
    });
    await judge.evaluate(systemOneRequest);
    assert.equal(authorization, "Bearer local-kev-test-key");
  } finally {
    if (savedKev === undefined) delete process.env.KEV_API_KEY; else process.env.KEV_API_KEY = savedKev;
    if (savedLaya === undefined) delete process.env.LAYA_API_KEY; else process.env.LAYA_API_KEY = savedLaya;
  }
});

test("concurrent local evaluations share one Compose startup", async () => {
  let composeCalls = 0;
  let requests = 0;
  const judge = await localRuntime("kev", async () => { composeCalls++; }, async (_input, init) => {
    if (init?.method === "POST") { requests++; return Response.json(systemOneResult); }
    return new Response(null, { status: 200 });
  });
  await Promise.all([judge.evaluate(systemOneRequest), judge.evaluate(systemOneRequest)]);
  assert.equal(composeCalls, 1);
  assert.equal(requests, 2);
});

test("an already-aborted local evaluation skips Compose startup and fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let processes = 0;
  let fetches = 0;
  const judge = await localRuntime("kev", async () => { processes++; }, async () => {
    fetches++;
    return new Response(null, { status: 200 });
  });
  await assert.rejects(judge.evaluate(systemOneRequest, { signal: controller.signal }));
  assert.deepEqual({ processes, fetches }, { processes: 0, fetches: 0 });
});

test("aborting one evaluation does not cancel shared local startup", async () => {
  let releaseStartup!: () => void;
  let announceStartup!: () => void;
  let composeCalls = 0;
  let posts = 0;
  const pendingStartup = new Promise<void>(resolve => { releaseStartup = resolve; });
  const startupCalled = new Promise<boolean>(resolve => { announceStartup = () => resolve(true); });
  const judge = await localRuntime("kev", async () => {
    composeCalls++;
    announceStartup();
    await pendingStartup;
  }, async (_input, init) => {
    if (init?.method === "POST") posts++;
    return init?.method === "POST" ? Response.json(systemOneResult) : new Response(null, { status: 200 });
  });
  const controller = new AbortController();
  const first = judge.evaluate(systemOneRequest, { signal: controller.signal });
  const second = judge.evaluate(systemOneRequest);
  const firstOutcome = first.then(() => "resolved", () => "rejected");
  const secondOutcome = second.then(() => "fulfilled", () => "rejected");
  try {
    assert.equal((await within(startupCalled, 100))?.value, true);
    controller.abort();
    assert.equal((await within(firstOutcome, 250))?.value, "rejected", "abort rejects before startup is released");
    assert.equal(composeCalls, 1);
  } finally { releaseStartup(); }
  assert.equal((await within(secondOutcome, 1000))?.value, "fulfilled");
  assert.equal(posts, 1, "the surviving evaluation submits exactly one POST");
});

test("a failed local startup leaves the judgment budget for one retry", async () => {
  const localModule = await import("../src/local-backend.js");
  const createClient = (localModule as typeof localModule & { createLocalJudgmentClient?: LocalJudgmentClientFactory }).createLocalJudgmentClient;
  assert.equal(typeof createClient, "function", "T-017 local judgment budget retry contract is not implemented");
  if (!createClient) return;
  let composeAttempts = 0;
  let posts = 0;
  let client: LocalJudgmentClientContract | undefined;
  const runtime = await localRuntime("kev", async () => {
    if (++composeAttempts === 1) throw new Error("offline Compose startup failure");
  }, async (_input, init) => {
    if (init?.method === "POST") {
      posts++;
      assert.equal(client?.getUsage().requestsStarted, 1, "request-start callback runs immediately before POST");
      return Response.json(systemOneResult);
    }
    return new Response(null, { status: 200 });
  });
  client = createClient(runtime as unknown as LocalRuntimeRequestStartContract, 1);
  await assert.rejects(client.evaluate(systemOneRequest));
  assert.equal(client.getUsage().requestsStarted, 0, "Compose failure precedes the counted request start");
  await client.evaluate(systemOneRequest);
  assert.deepEqual({ composeAttempts, posts, requestsStarted: client.getUsage().requestsStarted }, { composeAttempts: 2, posts: 1, requestsStarted: 1 });
});

test("a local service failure rejects without trying the Jev endpoint", async () => {
  for (const backend of ["kev", "laya"] as const) {
    const calls: string[] = [];
    const judge = await localRuntime(backend, async (_command, args) => { calls.push(args.join(" ")); }, async input => {
      calls.push(String(input));
      return new Response("offline", { status: 503 });
    });
    await assert.rejects(judge.evaluate(systemOneRequest));
    assert.ok(calls.some(call => call.includes(backend)), `${backend} was the only service started`);
    assert.ok(!calls.some(call => call.includes("api.typesafe.ai")), "local failure never silently falls back to Jev");
  }
});

test("npm pack contains pi-warden-owned Compose and backend Docker assets", () => {
  const root = resolve(import.meta.dirname, "..");
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" })) as Array<{ files: Array<{ path: string }> }>;
  const paths = packed[0]!.files.map(file => file.path);
  assert.ok(paths.includes("docker/compose.yaml"), "Compose configuration is included in the published package");
  assert.ok(paths.includes("docker/compose.env"), "explicit Compose env file is included in the published package");
  for (const backend of ["kev", "laya"] as const) assert.ok(paths.includes(`docker/Dockerfile.${backend}`), `${backend} Dockerfile is included in the published package`);
});
