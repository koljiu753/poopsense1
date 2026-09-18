import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig, type WeeklyHealthReport } from "./api";
import "./weekly-report.css";

export function beijingWeekStart(now = new Date()) {
  const day = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

function beijingTime(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

type Props = { config: AppConfig; memberId: string; friendlyError: (error: unknown) => string };

export default function WeeklyReportPanel(props: Props) {
  // Member/identity changes discard the old view and its in-flight responses.
  return <WeeklyReportContent key={`${props.config.apiBase}:${props.config.householdId}:${props.config.householdKey}:${props.memberId}`} {...props} />;
}

function WeeklyReportContent({ config, memberId, friendlyError }: Props) {
  const [reports, setReports] = useState<WeeklyHealthReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const mounted = useRef(true);
  const writing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api.weeklyReports(config, memberId)
      .then(result => { if (active) { setReports(result.filter(item => item.member_id === memberId)); setLoaded(true); } })
      .catch(caught => { if (active) { setLoaded(false); setError(friendlyError(caught)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [config, memberId, readAttempt, friendlyError]);

  const currentWeek = beijingWeekStart();
  const currentReport = reports.find(report => report.period_start === currentWeek);
  const latest = currentReport ?? [...reports].sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
  async function generateReport() {
    if (!loaded || writing.current || readOnly) return;
    writing.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const report = await api.generateWeeklyReport(config, memberId);
      if (!mounted.current) return;
      if (report.member_id !== memberId) throw new Error("REPORT_MEMBER_MISMATCH");
      const unchanged = currentReport?.facts.schema_version === 2 && report.facts.schema_version === 2
        && currentReport.report_id === report.report_id && currentReport.facts.revision === report.facts.revision
        && currentReport.facts.data_as_of === report.facts.data_as_of;
      setReports(previous => [report, ...previous.filter(item => item.report_id !== report.report_id && item.period_start !== report.period_start)]);
      setNotice(unchanged ? "记录没有变化，已是最新周回顾。" : "本周回顾已更新。" );
    } catch (caught) {
      if (!mounted.current) return;
      if (caught instanceof ApiError && caught.status === 403) {
        setReadOnly(true);
        setError("你可以阅读已授权的周回顾；更新需要本人或家庭管理权限。");
      } else setError(caught instanceof ApiError && caught.message === "WEEKLY_REPORT_BUSY"
        ? "周回顾正在更新，请稍后再试。" : friendlyError(caught));
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const modern = latest?.facts.schema_version === 2 && latest.facts.timezone === "Asia/Shanghai";
  const days = modern && Number.isInteger(latest?.facts.reliable_days) ? latest?.facts.reliable_days : undefined;
  const cutoff = modern ? beijingTime(latest?.facts.data_as_of) : null;
  const updated = modern ? beijingTime(latest?.facts.generated_at) : null;
  const coverage = latest && Number.isFinite(latest.facts.coverage) ? `${Math.round(latest.facts.coverage * 100)}%` : "—";
  return (
    <article className="weekly-report-panel week-review" aria-label="一周回顾" aria-busy={loading || busy}>
      <div className="weekly-report-head">
        <div className="card-title"><span>WEEKLY</span><h2>一周回顾</h2></div>
        <button type="button" onClick={() => void generateReport()} disabled={loading || !loaded || busy || readOnly}>
          {readOnly ? "仅可阅读" : busy ? "正在整理…" : currentReport ? "更新本周周报" : "生成本周周报"}
        </button>
      </div>
      <p className="week-review-calendar">按北京时间，周一至周日整理。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!loaded && !loading ? <button type="button" className="week-review-retry" onClick={() => setReadAttempt(attempt => attempt + 1)}>重试读取周报</button> : null}
      {notice ? <p className="week-review-notice" role="status">{notice}</p> : null}
      {loading ? <p role="status">正在读取周回顾…</p> : !latest ? (
        loaded ? <p className="muted">本周还没有周回顾。整理已有记录，看看记到了几天、接下来关注什么。</p> : null
      ) : (
        <div className="weekly-report-body">
          <div className="week-review-intro">
            <small>{latest.period_start} — {latest.period_end} · {currentReport ? "本周" : "以往周回顾"}</small>
            {!currentReport ? <p className="week-review-old">本周还未生成，下面是最近保存的一周。</p> : null}
            {!modern ? <p className="week-review-old">这是旧版周报，统计窗口与截止时间未记录，不能按标题确认是自然周。更新本周后使用新的统计方式。</p> : null}
            <strong>{latest.status === "ready" ? "这一周的记录" : "还在积累记录"}</strong>
            <p>{latest.summary}</p>
          </div>
          <div className="weekly-facts" aria-label="周报事实">
            <span><b>{days === undefined ? "—" : days}<small> / 7 天</small></b>有可靠记录的天数</span>
            <span><b>{latest.facts.valid_sessions}<small> 次</small></b>可靠记录</span>
            <span><b>{coverage}</b>有效样本占比</span>
          </div>
          <p className="week-review-explanation">有效样本占比是可靠记录占已归属记录的比例，与记录天数不同。没有记录不代表没有排便。</p>
          {days === undefined ? <p className="week-review-explanation">旧版未统计可靠记录天数，暂不推算。</p> : null}
          <p className="week-review-asof">{cutoff ? `数据截至 ${cutoff}（北京时间）` : "数据截止时间未记录"}</p>
          {latest.facts.consecutive_abnormal > 0 ? <p className="week-review-attention">有 {latest.facts.consecutive_abnormal} 次连续需关注记录，请结合具体记录与自身感受回看。</p> : null}
          {latest.recommendations.length ? <div className="week-review-next"><h3>接下来可以留意</h3><ul>{latest.recommendations.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
          <details className="week-review-details">
            <summary>查看统计说明与来源</summary>
            <p>{modern ? `统计范围：北京时间 ${latest.period_start} 00:00 起，至上述数据截止时刻。` : "旧版统计窗口未保存，不用日期标题推断取数范围。"}</p>
            {modern && latest.facts.assigned_sessions !== undefined ? <p>已归属记录 {latest.facts.assigned_sessions} 次，其中可靠记录 {latest.facts.valid_sessions} 次。</p> : null}
            <p>{updated ? `回顾更新于 ${updated}（北京时间）` : `首次保存于 ${beijingTime(latest.created_at) ?? "未知时间"}（北京时间），不代表数据截止时间。`}</p>
            <small>依据 {latest.policy_version} · {latest.model_version}</small>
          </details>
        </div>
      )}
    </article>
  );
}
