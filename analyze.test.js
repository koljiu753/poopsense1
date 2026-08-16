import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHardwarePayload } from "../lib/analyze.js";

const basePayload = {
  event_id: "evt_001",
  color_category: "brown_like",
  color_confidence: 0.82,
  odor_deviation: "moderate",
  odor_change_pct: 31.2,
  odor_confidence: 0.71,
  temperature_c: 24.8,
  humidity_pct: 63.1,
  sample_quality: "usable"
};

test("accepts the hardware team's current Python JSON", () => {
  const result = analyzeHardwarePayload(basePayload);
  assert.equal(result.ok, true);
  assert.equal(result.value.event_id, "evt_001");
  assert.equal(result.value.observation.odor_response_level, "moderate");
  assert.equal(result.value.observation.odor_reference_type, "device_sensor_baseline");
  assert.equal(result.value.attention.level, "routine");
  assert.equal(result.value.timeline.status, "not_evaluable");
});

test("special sensor colors only request confirmation", () => {
  const result = analyzeHardwarePayload({ ...basePayload, color_category: "red_like" });
  assert.equal(result.ok, true);
  assert.equal(result.value.attention.level, "confirm_prompt");
  assert.deepEqual(result.value.attention.triggered_rule_ids, ["SPECIAL_COLOR_CONFIRM_ONLY"]);
  assert.equal(result.value.analysis_engine.llm_used, false);
  assert.match(result.value.report.summary, /不代表疾病或病因/);
});

test("unusable samples are not evaluable", () => {
  const result = analyzeHardwarePayload({ ...basePayload, sample_quality: "unusable" });
  assert.equal(result.ok, true);
  assert.equal(result.value.analysis_status, "not_evaluable");
  assert.equal(result.value.attention.level, "not_evaluable");
});

test("rejects invalid confidence values", () => {
  const result = analyzeHardwarePayload({ ...basePayload, color_confidence: 1.5 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /color_confidence/);
});

test("accepts an outer observation envelope", () => {
  const result = analyzeHardwarePayload({ event_id: "evt_outer", observation: basePayload });
  assert.equal(result.ok, true);
  assert.equal(result.value.event_id, "evt_outer");
});
