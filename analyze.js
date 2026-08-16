const SPECIAL_COLOR_CATEGORIES = new Set([
  "red_like",
  "black_like",
  "pale_gray_like"
]);

const QUALITY_ALIASES = new Map([
  ["usable", "usable"],
  ["valid", "usable"],
  ["partial", "partial"],
  ["unusable", "unusable"],
  ["invalid", "unusable"]
]);

const ODOR_LEVELS = new Set(["low", "moderate", "medium", "high"]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function confidence(value, field, errors) {
  if (value == null) return null;
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    errors.push(`${field} must be a number from 0 to 1`);
    return null;
  }
  return value;
}

function optionalNumber(value, field, errors) {
  if (value == null) return null;
  if (!isFiniteNumber(value)) {
    errors.push(`${field} must be a finite number`);
    return null;
  }
  return value;
}

export function normalizeHardwarePayload(payload) {
  const source = payload?.observation && typeof payload.observation === "object"
    ? { ...payload.observation, event_id: payload.event_id ?? payload.eventId ?? payload.observation.event_id }
    : payload;

  const errors = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }

  const eventId = source.event_id ?? source.eventId;
  if (typeof eventId !== "string" || eventId.trim().length === 0 || eventId.length > 128) {
    errors.push("event_id must be a non-empty string up to 128 characters");
  }

  const colorCategory = source.color_category ?? null;
  if (colorCategory != null && (typeof colorCategory !== "string" || colorCategory.length > 64)) {
    errors.push("color_category must be null or a string up to 64 characters");
  }

  let odorLevel = source.odor_response_level ?? source.odor_deviation ?? null;
  if (odorLevel === "medium") odorLevel = "moderate";
  if (odorLevel != null && !ODOR_LEVELS.has(odorLevel)) {
    errors.push("odor_deviation must be low, moderate, medium, high, or null");
  }

  const rawQuality = source.sample_quality ?? "partial";
  const sampleQuality = QUALITY_ALIASES.get(rawQuality);
  if (!sampleQuality) {
    errors.push("sample_quality must be usable, partial, unusable, valid, or invalid");
  }

  const normalized = {
    event_id: typeof eventId === "string" ? eventId.trim() : null,
    color_category: typeof colorCategory === "string" ? colorCategory : null,
    color_confidence: confidence(source.color_confidence, "color_confidence", errors),
    odor_response_level: odorLevel,
    odor_response_change_pct: optionalNumber(
      source.odor_response_change_pct ?? source.odor_change_pct,
      "odor_change_pct",
      errors
    ),
    odor_reference_type: source.odor_reference_type ?? "device_sensor_baseline",
    odor_confidence: confidence(source.odor_confidence, "odor_confidence", errors),
    temperature_c: optionalNumber(source.temperature_c, "temperature_c", errors),
    humidity_pct: optionalNumber(source.humidity_pct, "humidity_pct", errors),
    sample_quality: sampleQuality ?? null
  };

  return errors.length ? { ok: false, errors } : { ok: true, value: normalized };
}

export function analyzeObservation(observation) {
  const isSpecialColor = SPECIAL_COLOR_CATEGORIES.has(observation.color_category);
  const qualityInsufficient = observation.sample_quality === "unusable";

  let attentionLevel = "routine";
  const ruleIds = [];

  if (qualityInsufficient) {
    attentionLevel = "not_evaluable";
    ruleIds.push("QUALITY_UNUSABLE");
  } else if (isSpecialColor) {
    attentionLevel = "confirm_prompt";
    ruleIds.push("SPECIAL_COLOR_CONFIRM_ONLY");
  }

  const timelineStatus = "not_evaluable";
  const observationParts = [];

  if (observation.color_category) {
    observationParts.push(`颜色特征为 ${observation.color_category}`);
  }
  if (observation.odor_response_level) {
    observationParts.push(`气味响应等级为 ${observation.odor_response_level}`);
  }

  let title = "本次传感器数据已接收";
  let summary = observationParts.length
    ? `本次观测：${observationParts.join("，")}。`
    : "本次可用传感器特征有限。";
  let nextSteps = ["继续积累同一成员的多次有效记录，用于建立个人时间轴基线。"];

  if (attentionLevel === "not_evaluable") {
    title = "本次数据暂时无法可靠评估";
    summary = "样本质量不足，系统没有把本次结果解释为正常或异常。";
    nextSteps = ["检查传感器状态并重新采集。"];
  } else if (attentionLevel === "confirm_prompt") {
    title = "请确认本次颜色变化";
    summary = "光谱传感器识别到需要人工确认的颜色特征；单次传感器结果不代表疾病或病因。";
    nextSteps = [
      "请用户确认真实外观是否与传感器结果一致。",
      "记录近期食物、补充剂或清洁剂等可能干扰因素。",
      "若变化反复出现或同时感到不适，再考虑寻求专业医疗建议。"
    ];
  }

  return {
    schema_version: "poopsense.analysis.mvp.v1",
    event_id: observation.event_id,
    analysis_status: attentionLevel === "not_evaluable" ? "not_evaluable" : "completed",
    observation: {
      color_category: observation.color_category,
      color_confidence: observation.color_confidence,
      odor_response_level: observation.odor_response_level,
      odor_response_change_pct: observation.odor_response_change_pct,
      odor_reference_type: observation.odor_reference_type,
      odor_confidence: observation.odor_confidence,
      bristol_type: null,
      event_duration_seconds: null,
      sample_quality: observation.sample_quality,
      environment: {
        temperature_c: observation.temperature_c,
        humidity_pct: observation.humidity_pct,
        health_interpretation_allowed: false
      }
    },
    timeline: {
      status: timelineStatus,
      reason: "MVP 接口尚未连接成员历史数据库，不能判断相对个人基线的变化。"
    },
    attention: {
      level: attentionLevel,
      triggered_rule_ids: ruleIds
    },
    report: {
      title,
      summary,
      next_steps: nextSteps,
      disclaimer: "PoopSense 仅提供个人趋势参考，不提供医学诊断。"
    },
    analysis_engine: {
      type: "deterministic_rules",
      version: "mvp-rules-1.0.0",
      llm_used: false
    }
  };
}

export function analyzeHardwarePayload(payload) {
  const parsed = normalizeHardwarePayload(payload);
  if (!parsed.ok) return parsed;
  return { ok: true, value: analyzeObservation(parsed.value) };
}
