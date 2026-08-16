const MODEL_ID = "deepseek-v4-flash";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const FORBIDDEN_DIAGNOSIS_PATTERNS = [
  /诊断为/i,
  /患有/i,
  /你有[^效可用]/i,
  /癌症/i,
  /肿瘤/i,
  /内出血/i,
  /you have/i,
  /diagnosed with/i
];

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model_output_not_json");
  return JSON.parse(text.slice(start, end + 1));
}

function validateGeneratedReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model_report_not_object");
  }

  const title = typeof value.title === "string" ? value.title.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  const nextSteps = Array.isArray(value.next_steps)
    ? value.next_steps.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];

  if (!title || title.length > 80) throw new Error("model_title_invalid");
  if (!summary || summary.length > 400) throw new Error("model_summary_invalid");
  if (nextSteps.length < 1 || nextSteps.length > 3 || nextSteps.some((item) => item.length > 160)) {
    throw new Error("model_next_steps_invalid");
  }

  const combined = [title, summary, ...nextSteps].join(" ");
  if (FORBIDDEN_DIAGNOSIS_PATTERNS.some((pattern) => pattern.test(combined))) {
    throw new Error("model_medical_boundary_violation");
  }

  return { title, summary, next_steps: nextSteps };
}

export async function enrichAnalysisWithLlm(analysis, generateTextOverride) {
  if (analysis.analysis_status === "not_evaluable") {
    return {
      ...analysis,
      analysis_engine: {
        type: "hybrid_rules_llm",
        version: "mvp-hybrid-1.0.0",
        model_id: MODEL_ID,
        llm_used: false,
        fallback_reason: "quality_not_evaluable"
      }
    };
  }

  try {
    const immutableInput = {
      observation: analysis.observation,
      timeline: analysis.timeline,
      attention: analysis.attention,
      safe_template: analysis.report
    };

    const systemPrompt = [
        "你是 PoopSense 的健康趋势解释助手，只能解释已经结构化的传感器观测。",
        "attention.level 和 triggered_rule_ids 是确定性安全规则的结果，绝对不能修改、弱化或升级。",
        "不得诊断疾病、推测病因，或把环境温湿度解释成人体健康指标。",
        "气味百分比只表示设备传感器参考值变化，不是医学浓度，也不是个人历史基线。",
        "特殊颜色只能要求用户确认；仅当输入模板已经允许时，才可温和建议关注重复变化或伴随不适。",
        "使用简洁自然的中文。只输出 JSON，不要 Markdown。",
        "JSON 格式必须是 {\"title\":string,\"summary\":string,\"next_steps\":[string]}。"
      ].join("\n");

    let result;
    if (generateTextOverride) {
      result = await generateTextOverride({ system: systemPrompt, prompt: JSON.stringify(immutableInput) });
    } else {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error("missing_deepseek_api_key");

      const response = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL_ID,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(immutableInput) }
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          max_tokens: 450,
          stream: false
        }),
        signal: AbortSignal.timeout(25000)
      });

      if (!response.ok) throw new Error(`deepseek_http_${response.status}`);
      const body = await response.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("deepseek_empty_output");
      result = {
        text,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? null,
          outputTokens: body.usage?.completion_tokens ?? null,
          totalTokens: body.usage?.total_tokens ?? null
        }
      };
    }

    const generatedReport = validateGeneratedReport(extractJson(result.text));
    return {
      ...analysis,
      report: {
        ...generatedReport,
        disclaimer: analysis.report.disclaimer
      },
      analysis_engine: {
        type: "hybrid_rules_llm",
        version: "mvp-hybrid-1.0.0",
        model_id: MODEL_ID,
        provider: "deepseek",
        llm_used: true,
        usage: {
          input_tokens: result.usage?.inputTokens ?? null,
          output_tokens: result.usage?.outputTokens ?? null,
          total_tokens: result.usage?.totalTokens ?? null
        }
      }
    };
  } catch (error) {
    return {
      ...analysis,
      analysis_engine: {
        type: "hybrid_rules_llm",
        version: "mvp-hybrid-1.0.0",
        model_id: MODEL_ID,
        provider: "deepseek",
        llm_used: false,
        fallback_reason: error instanceof Error ? error.message.slice(0, 120) : "unknown_model_error"
      }
    };
  }
}
