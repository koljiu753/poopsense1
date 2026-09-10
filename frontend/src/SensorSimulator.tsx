import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig } from "./api";

export function SensorSimulator({ config, memberId, onReceived }: {
  config: AppConfig; memberId: string;
  onReceived: (sessionId: string, pending: boolean) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [temporaryStorage, setTemporaryStorage] = useState(false);
  const [scenario, setScenario] = useState("dry");
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const attempt = useRef<Parameters<typeof api.simulateSensor>[1] | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    let active = true;
    setEnabled(false);
    setTemporaryStorage(false);
    void api.simulationStatus(config).then(result => {
      if (active) { setEnabled(result.enabled); setTemporaryStorage(result.reason === "temporary_storage"); }
    }).catch(() => {});
    return () => { active = false; };
  }, [config]);
  async function simulate() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    const previous = attempt.current;
    const member = pending ? null : memberId;
    if (!previous || previous.scenario !== scenario || previous.member_id !== member) {
      attempt.current = { request_id: crypto.randomUUID(), timestamp: new Date().toISOString(), scenario, member_id: member };
    }
    try {
      const result = await api.simulateSensor(config, attempt.current!);
      await onReceived(result.session_id, result.assignment_status === "pending_claim");
      attempt.current = null;
      setMessage(pending ? "模拟记录已收到，请在健康页确认归属。" : "模拟记录已收到，正在打开分析。 ");
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) attempt.current = null;
      setMessage(error instanceof ApiError && error.status === 429
        ? "本小时的演示次数已用完，请稍后再试。"
        : "本次未完成，请重试；同一次请求不会重复添加记录。");
    } finally { locked.current = false; setBusy(false); }
  }
  if (!enabled) return temporaryStorage ? <p className="simulation-label" role="status">在线版使用临时演示数据，请勿录入真实信息。完整模拟检测目前在本地版开放，接通持久存储后再开放在线体验。</p> : null;
  return <details className="sensor-simulator">
    <summary>体验一次传感器检测 <small>仅模拟数据</small></summary>
    <p>不用连接硬件。预设数据会经过接收、归属和分析流程；当前演示空间是共用的，请勿输入真实健康信息。</p>
    <div className="simulator-controls">
      <label>模拟状态<select value={scenario} disabled={busy} onChange={event => setScenario(event.target.value)}>
        <option value="dry">一颗颗、偏干硬</option><option value="normal">成形、平稳</option>
        <option value="loose">偏稀软</option><option value="uncertain">采集不清楚</option>
        <option value="redline">需重视的颜色信号</option>
      </select></label>
      <label><input type="checkbox" checked={pending} disabled={busy} onChange={event => setPending(event.target.checked)} />先体验待认领</label>
      <button disabled={busy || !["m_001", "m_002"].includes(memberId)} onClick={() => void simulate()}>{busy ? "正在接收…" : "开始模拟检测"}</button>
    </div>
    <p role="status">{message}</p>
  </details>;
}
