import test from "node:test";
import assert from "node:assert/strict";
import { TurnDiagnostics } from "../src/workbuddy/turn-diagnostics.js";

test("successful diagnostics discard input while failed diagnostics retain only the bounded latest preview", () => {
  const diagnostics = new TurnDiagnostics({ limit: 2 });
  diagnostics.start("success", { prompt: "processed chat text", model: "test", groupId: "123456" });
  assert.equal(diagnostics.snapshot("success", { includeInput: true }).inputPreview, "processed chat text");
  diagnostics.finish("success");
  const success = diagnostics.snapshot("success", { includeInput: true });
  assert.equal(Object.hasOwn(success, "inputPreview"), false);
  assert.equal(success.inputChars, 19);
  assert.equal(success.stage, "complete");

  diagnostics.start("failure", { prompt: "old failure", model: "test", groupId: "123456" });
  diagnostics.start("failure", { prompt: "x".repeat(40_000), model: "test", groupId: "123456" });
  diagnostics.finish("failure", new Error("failed"));
  const failure = diagnostics.snapshot("failure", { includeInput: true });
  assert.equal(failure.inputPreview, "x".repeat(32_000));
  assert.equal(failure.inputTruncated, true);
  assert.equal(failure.requests, 2);
  assert.equal(diagnostics.turns.size, 2);
  assert.equal(Object.hasOwn(diagnostics.snapshot("failure"), "inputPreview"), false);
});
