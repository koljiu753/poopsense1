import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHardwarePayload } from "../lib/analyze.js";
import { enrichAnalysisWithLlm } from "../lib/llm.js";

const observation = {
  event_id: "evt_llm_test",
  color_category: "brown_like",
  color_confidence: 0.82,
  odor_deviation: "moderate",
  odor_confidence: 0.71,
  sample_quality: "usable"
};

test("uses valid model JSON without allowing rule changes", async () => {
  const base = analyzeHardwarePayload(observation).value;
  const output = await enrichAnalysisWithLlm(base, async () => ({
    text: JSON.stringify({
      title: "本次记录已完成",
      summary: "已记录本次颜色和气味响应特征，可继续积累个人趋势。",
      next_steps: ["保持日常记录即可。"]
    }),
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
  }));

  assert.equal(output.analysis_engine.llm_used, true);
  assert.equal(output.attention.level, "routine");
  assert.equal(output.report.disclaimer, base.report.disclaimer);
});

test("falls back when model output crosses the medical boundary", async () => {
  const base = analyzeHardwarePayload(observation).value;
  const output = await enrichAnalysisWithLlm(base, async () => ({
    text: JSON.stringify({
      title: "诊断为疾病",
      summary: "你有严重疾病。",
      next_steps: ["立即治疗。"]
    })
  }));

  assert.equal(output.analysis_engine.llm_used, false);
  assert.equal(output.report.title, base.report.title);
  assert.equal(output.attention.level, base.attention.level);
});
