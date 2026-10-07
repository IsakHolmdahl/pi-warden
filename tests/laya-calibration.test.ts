import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBatchQuestions } from "../src/conscience.js";
import { doneQuestions } from "../src/done.js";
import { formatQuestion } from "../src/excerpt.js";
import { questions as actionQuestions } from "../src/guard.js";
import { buildOutputRequest } from "../src/output.js";
import { judgeableQuestion } from "../src/rules-lint.js";
import { turnRuleQuestion } from "../src/turn-rules.js";

const choiceSize = (question: { type: string; criteria?: object | null } | undefined) =>
  question?.type === "choice" ? Object.keys(question.criteria ?? {}).length : 0;

test("fixed Warden choice schemas stay below Laya's uncalibrated choice:11+ bucket", () => {
  const outputQuestions = buildOutputRequest("bash", "ok", "task", false, true).questions;
  const conscienceQuestions = buildBatchQuestions([], "task", "", [], []).questions;
  const rule = { id: "test", name: "Test rule", body: "", paths: [] };
  const sizes = [
    choiceSize(doneQuestions.outcome), choiceSize(formatQuestion.format), choiceSize(actionQuestions.scope),
    choiceSize(outputQuestions.retention), choiceSize(outputQuestions.format),
    choiceSize(conscienceQuestions.conscience_disposition), choiceSize(judgeableQuestion(rule)),
    choiceSize(turnRuleQuestion(rule)),
  ];
  assert.equal(Math.max(...sizes), 9, "the output-format question is the largest fixed choice schema");
  assert.ok(sizes.every(size => size < 11));
});
