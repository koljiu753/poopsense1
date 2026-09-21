import type { RecordObservationDetails } from "./api";
import "./record-observations.css";

const valueLabels: Record<string, string> = {
  elongated: "条状", compact: "团块状", scattered: "分散状", irregular: "不规则",
  red: "红色", green: "绿色", blue: "蓝色", yellow: "黄色",
};
const reasonLabels: Record<string, string> = {
  sensor_disabled: "传感器停用", not_collected: "未采集", sample_failed: "采样失败",
  manual_sampling_not_health_session: "手动测试采样，不属于可评估健康会话",
  collection_not_completed: "采集未完成", overall_confidence_low: "整体可靠度不足",
  shape_missing: "形状缺失", color_missing: "颜色缺失", odor_missing: "气味缺失",
  shape_confidence_low: "形状可靠度不足", color_confidence_low: "颜色可靠度不足", odor_confidence_low: "气味可靠度不足",
};
const llmLabels = {
  not_applicable: "本次手动采样不适用大模型健康报告",
  not_requested: "未发起大模型报告",
  policy_only: "已有规则报告，未调用大模型",
  available: "已有模型报告",
  failed: "报告处理失败",
  pending: "报告处理中",
};
function describeReason(reason: string) { return reasonLabels[reason] ? `${reasonLabels[reason]}（${reason}）` : reason; }
function numberText(value: number | null | undefined, suffix = "") { return typeof value === "number" && Number.isFinite(value) ? `${value}${suffix}` : "未提供"; }

export default function RecordObservations({ record, expanded = false }: {
  record: RecordObservationDetails & { session_id: string };
  expanded?: boolean;
}) {
  const { sampling, processing, raw_observations: observations } = record;
  const manual = sampling?.session_kind === "manual_sampling" || sampling?.duration_semantics === "manual_sampling_seconds";
  return <details className="record-observations" open={expanded || undefined}>
    <summary>原始观测与处理状态 <code>{record.session_id}</code></summary>
    <div className="record-observations-body">
      <p className="observation-boundary">上传的分类仅用于核对采样，不是健康结论。颜色标签不代表出血；模板相似度不是准确率或已校准置信度。</p>
      {!observations && !sampling && !processing ? <p>这条旧记录尚未提供原始观测详情。</p> : null}
      {observations && <div className="raw-observations-grid">
        {([['shape', '形状'], ['color', '颜色'], ['odor', '气味']] as const).map(([kind, title]) => {
          const observation = observations[kind];
          const value = observation?.value;
          const scale = observation?.similarity_scale;
          return <section className="raw-observation" key={kind} aria-label={`${title}原始观测`}>
            <h3>{title}</h3>
            <b>{value == null ? "未采到分类" : valueLabels[value] ? `${valueLabels[value]}（${value}）` : value}</b>
            <dl>
              <dt>模板相似度</dt><dd>{numberText(observation?.template_similarity)}{observation?.template_similarity != null ? ` · 量纲：${scale === "0_1" ? "0–1" : scale === "0_100" ? "0–100" : "未说明"}` : ""}</dd>
              <dt>上传置信值</dt><dd>{numberText(observation?.confidence)}</dd>
              {observation?.change_pct != null && <><dt>上传变化值</dt><dd>{numberText(observation.change_pct, "%")}</dd></>}
              {observation?.missing_reason && <><dt>缺失原因</dt><dd>{describeReason(observation.missing_reason)}</dd></>}
              {observation && <><dt>来源 / 版本</dt><dd>{observation.source} / {observation.model_version}</dd></>}
            </dl>
          </section>;
        })}
      </div>}
      {sampling && <section className="sampling-facts" aria-label="采样信息">
        <h3>{manual ? "手动采样窗口" : "采集信息"}</h3>
        <dl>
          <dt>{manual ? "手动采样时长" : "上传采集时长"}</dt><dd>{numberText(sampling.duration_s, " 秒")}{manual && "（不是如厕时长）"}</dd>
          <dt>开始时间</dt><dd><time dateTime={sampling.started_at}>{sampling.started_at}</time></dd>
          <dt>结束时间</dt><dd><time dateTime={sampling.ended_at}>{sampling.ended_at}</time></dd>
          <dt>采集状态</dt><dd>{{ partial: "部分采集", failed: "采集失败", completed: "采集完成" }[sampling.collection_state] ?? sampling.collection_state}</dd>
          <dt>在场状态</dt><dd>{{ unknown: "未知（未据此判断成员）", present: "设备上报在场", absent: "设备上报不在场" }[sampling.presence_state] ?? sampling.presence_state}</dd>
          <dt>温度 / 湿度</dt><dd>{numberText(sampling.temperature_c, " °C")} / {numberText(sampling.humidity_pct, "%")}</dd>
        </dl>
      </section>}
      {processing && <section className="record-processing" aria-label="记录处理状态">
        <h3>处理状态</h3>
        <p><b>{processing.analysis_complete ? "规则处理已完成" : "规则处理尚未完成"}</b> · {manual || !processing.reliable ? "无法可靠判断健康状态" : "可查看规则评估"}</p>
        <p>{processing.message}</p>
        <p>大模型：{processing.llm_status ? llmLabels[processing.llm_status] ?? "未提供明确状态" : "未提供明确状态"}</p>
        {!!processing.reasons.length && <details><summary>查看规则依据</summary><ul>{processing.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{describeReason(reason)}</li>)}</ul></details>}
      </section>}
    </div>
  </details>;
}
