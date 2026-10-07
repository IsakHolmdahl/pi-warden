import { ask as askTypeSafe, DEFAULT_ASK_TIMEOUT_MS, TypeSafeIntegrationError } from "pi-typesafe";
import type { AskAnswer, AskOptions, Judge, Questions, SystemOneRequest } from "pi-typesafe";
import { localJudgmentClientBrand } from "./local-backend.js";
import type { LocalJudgmentClient } from "./local-backend.js";

const FALLBACK_MESSAGE = "TypeSafe request failed.";

function isLocalJudge(judge: Judge): judge is Judge & LocalJudgmentClient {
  return (judge as Partial<LocalJudgmentClient>)[localJudgmentClientBrand] === true;
}

/** Keep a local caller's cancellation separate from its per-request deadline, which begins after service readiness. */
export async function askJudgment<Q extends Questions>(
  judge: Judge,
  request: SystemOneRequest<Q>,
  options?: AskOptions,
): Promise<AskAnswer<Q>> {
  if (!isLocalJudge(judge)) return askTypeSafe(judge, request, options);
  try {
    const result = await judge.evaluate(request, {
      ...(options?.signal ? { signal: options.signal } : {}),
      requestTimeoutMs: options?.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
    });
    return { ok: true, answers: result.answers, model: result.model, usage: result.usage, elapsedMs: result.elapsedMs };
  } catch (error) {
    if (error instanceof TypeSafeIntegrationError) return { ok: false, error: error.message, errorCode: error.code };
    return { ok: false, error: FALLBACK_MESSAGE };
  }
}
