import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig } from "./api";
import "./record-observations.css";

export default function FamilyConnectionSettings({ config, onSave, initiallyOpen = false }: {
  config: AppConfig;
  onSave: (next: AppConfig) => void;
  initiallyOpen?: boolean;
}) {
  const [draft, setDraft] = useState(config);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  async function reconnect() {
    if (pending.current) return;
    const next = { apiBase: draft.apiBase.trim().replace(/\/+$/, ""), householdId: draft.householdId.trim(), householdKey: draft.householdKey.trim() };
    if (!next.householdId || !next.householdKey) { setError("请填写这次测试环境对应的家庭 ID 和家庭访问密钥。"); return; }
    if (next.apiBase) {
      try { if (!["http:", "https:"].includes(new URL(next.apiBase).protocol)) throw new Error(); }
      catch { setError("API 地址需为完整的 http 或 https 地址；使用 Reader 当前服务时留空即可。"); return; }
    }
    pending.current = true; setChecking(true); setError("");
    try {
      const members = await api.members(next);
      if (!current.current) return;
      if (!members.length) { setError("这个家庭还没有可查看的成员，请先由联调负责人登记测试成员。当前连接未切换。"); return; }
      onSave(next);
    } catch (caught) {
      if (!current.current) return;
      setError(caught instanceof ApiError && [401, 403].includes(caught.status)
        ? "家庭授权未通过。请核对这次环境的家庭 ID 和家庭访问密钥；当前连接未切换。"
        : "暂时无法验证家庭连接，请检查地址或网络后重试。当前连接未切换。");
    } finally {
      pending.current = false;
      if (current.current) setChecking(false);
    }
  }
  return <details className="advanced-settings connection-settings" open={initiallyOpen || undefined}>
    <summary>开发连接设置</summary>
    <form className="form-card" onSubmit={event => { event.preventDefault(); void reconnect(); }}>
      <p className="connection-note">当前家庭 ID：<b>{config.householdId}</b>。硬件绑定的家庭与这里需一致；设备密钥和大模型密钥不能用于家庭查看。</p>
      <label>API 地址<input value={draft.apiBase} disabled={checking} autoComplete="off" placeholder="留空，使用 Reader 当前服务" onChange={event => setDraft({ ...draft, apiBase: event.target.value })} /></label>
      <label>家庭 ID<input value={draft.householdId} disabled={checking} autoComplete="off" onChange={event => setDraft({ ...draft, householdId: event.target.value })} /></label>
      <label>家庭访问密钥<input type="password" value={draft.householdKey} disabled={checking} autoComplete="off" onChange={event => setDraft({ ...draft, householdKey: event.target.value })} /></label>
      <p className="connection-note">先验证查看授权，再保存到当前浏览器会话。密钥不会放进分享链接。</p>
      {error && <p role="alert">{error}</p>}
      <button className="comic-button wide" disabled={checking} type="submit">{checking ? "正在验证家庭授权…" : "保存并重新连接"}</button>
    </form>
  </details>;
}
