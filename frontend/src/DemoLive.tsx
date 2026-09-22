import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig, type Device, type HouseholdSession, type DemoExplanationResult } from "./api";
import DemoExplanation from "./DemoExplanation";
import DemoSampleVisual from "./DemoSampleVisual";
import ResultArrivalFrame from "./ResultArrivalFrame";
import RecordObservations from "./RecordObservations";
import RecordSource from "./RecordSource";
import "./demo-live.css";

function storageKey(config: AppConfig, deviceId = "") {
  return `poopsense-demo-v1:${JSON.stringify([config.apiBase, config.householdId, deviceId])}`;
}
function savedValue(key: string) {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return null; }
}
function saveValue(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The live view also works without browser storage. */ }
}
function isDemo(record: HouseholdSession, deviceId: string) {
  return record.device_id === deviceId && record.sampling?.session_kind === "manual_sampling"
    && (record.data_kind === "simulated" || record.data_kind === "hardware_test");
}
function useVisible() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export default function DemoLive(props: { config: AppConfig; active: boolean; onSettings: () => void; onRecords: () => void }) {
  // A credential change remounts the entire connection scope without putting keys in URLs or storage names.
  const identity = useRef({ config: props.config, version: 0 });
  if (identity.current.config !== props.config) identity.current = { config: props.config, version: identity.current.version + 1 };
  return <DemoConnection key={identity.current.version} {...props} />;
}

function DemoConnection({ config, active, onSettings, onRecords }: {
  config: AppConfig; active: boolean; onSettings: () => void; onRecords: () => void;
}) {
  const visible = useVisible();
  const running = active && visible;
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    setLoading(true);
    void api.devices(config, controller.signal).then(items => {
      if (controller.signal.aborted) return;
      const available = items.filter(device => device.active && device.household_id === config.householdId);
      setDevices(available);
      setSelected(previous => {
        const remembered = previous || savedValue(storageKey(config))?.deviceId;
        return available.some(device => device.device_id === remembered) ? remembered : available.length === 1 ? available[0].device_id : "";
      });
      setError("");
    }).catch(caught => {
      if (controller.signal.aborted) return;
      if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) { setDevices([]); setSelected(""); }
      setError("暂时无法读取当前家庭的设备，请检查连接设置后重试。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [config, running, retry]);
  useEffect(() => { if (selected) saveValue(storageKey(config), { deviceId: selected }); }, [config, selected]);
  return <section className="page demo-live-page" aria-label="硬件演示">
    <header className="demo-live-heading"><small>SEE. SMELL. SENSE.</small><h1>收到信号，一起看看。</h1>
      <p>先选好设备，让这个页面留在前台。上传后会自动出现演示形象和 AI 解读。</p></header>
    <div className="demo-device-controls">
      <label>演示设备<select aria-label="演示设备" value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">{loading ? "正在读取设备…" : devices.length ? "选择这次演示的设备" : "暂无可用设备"}</option>
        {devices.map(device => <option key={device.device_id} value={device.device_id}>{device.device_id}</option>)}
      </select></label>
      <button type="button" onClick={onSettings}>家庭连接设置</button>
      <button type="button" onClick={onRecords}>按 ID 排查记录</button>
    </div>
    <p className="demo-live-boundary">当前是家庭设备演示，不代表正在查看的成员。卡纸、橡皮泥等观测只用于演示，不进入个人健康结论。</p>
    {error && <p role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试读取设备</button></p>}
    {selected && <DemoDeviceFeed key={selected} config={config} deviceId={selected} active={running && !error} />}
    {!selected && !loading && !error && <p role="status">{devices.length ? "请选择一个设备，开始接收演示记录。" : "连接测试家庭后，这里会列出已启用的设备。"}</p>}
  </section>;
}

type FeedStore = { cursor?: number; pending: string[]; done: string[]; selected: string; records: Map<string, HouseholdSession>; hydrated: boolean; denied: Set<string>; blocked: boolean };
function restoreFeed(key: string): FeedStore {
  const saved = savedValue(key);
  const ids = (items: unknown) => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === "string" && !!item))] : [];
  return {
    cursor: Number.isSafeInteger(saved?.cursor) && saved.cursor >= 0 ? saved.cursor : undefined,
    pending: ids(saved?.pending), done: ids(saved?.done).slice(-20), selected: "", records: new Map(), hydrated: false, denied: new Set(), blocked: false,
  };
}

function DemoDeviceFeed({ config, deviceId, active }: { config: AppConfig; deviceId: string; active: boolean }) {
  const key = storageKey(config, deviceId);
  const [store] = useState(() => restoreFeed(key));
  const [, render] = useState(0);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [ready, setReady] = useState(false);
  const [terminal, setTerminal] = useState("");
  const [recordReadError, setRecordReadError] = useState("");
  const request = useRef<AbortController | null>(null);
  const publish = useCallback(() => {
    saveValue(key, { cursor: store.cursor, pending: store.pending, done: store.done });
    render(value => value + 1);
  }, [key, store]);
  const clearScope = useCallback(() => {
    request.current?.abort(); request.current = null;
    store.records.clear(); store.pending = []; store.done = []; store.selected = ""; store.cursor = undefined; store.hydrated = false;
    store.blocked = true;
    setTerminal(""); setReading(false); publish();
    setError("当前家庭无法继续查看这个设备的记录，请检查设备和家庭授权。");
  }, [publish, store]);
  const unavailable = useCallback((sessionId: string, status: number) => {
    if (status === 401) { clearScope(); return; }
    store.denied.add(sessionId);
    store.records.delete(sessionId);
    store.pending = store.pending.filter(id => id !== sessionId);
    store.done = store.done.filter(id => id !== sessionId);
    if (store.selected === sessionId) store.selected = "";
    setTerminal(previous => previous === sessionId ? "" : previous);
    setRecordReadError("一条记录已无法查看，已移除其观测和解读，继续接收可查看的记录。");
    publish();
  }, [clearScope, publish, store]);
  const refresh = useCallback(async () => {
    if (!active || document.hidden || store.blocked || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller;
    setReading(true);
    try {
      if (!store.hydrated) {
        const ids = [...new Set([...store.pending, ...store.done])];
        const restored = await Promise.allSettled(ids.map(id => api.sessionById(config, id, controller.signal)));
        if (!current()) return;
        const unavailable = new Set<string>();
        for (let index = 0; index < restored.length; index += 1) {
          const response = restored[index];
          if (response.status === "fulfilled") {
            if (response.value.session_id === ids[index] && isDemo(response.value, deviceId)) store.records.set(ids[index], response.value);
            else unavailable.add(ids[index]);
          } else if (response.reason instanceof ApiError && [403, 404, 409].includes(response.reason.status)) unavailable.add(ids[index]);
          else throw response.reason;
        }
        store.pending = store.pending.filter(id => !unavailable.has(id));
        store.done = store.done.filter(id => !unavailable.has(id));
        unavailable.forEach(id => { store.denied.add(id); store.records.delete(id); });
        store.hydrated = true;
        publish();
      }
      let more = true;
      while (more && current()) {
        const page = await api.demoSessions(config, deviceId, store.cursor, controller.signal);
        if (!current()) return;
        if (!Number.isSafeInteger(page.next_after_id) || page.next_after_id < (store.cursor ?? 0)
            || page.has_more && page.next_after_id === store.cursor) throw new Error("Unexpected feed cursor");
        for (const record of page.items) {
          if (!isDemo(record, deviceId) || store.denied.has(record.session_id)) continue;
          if (!store.records.has(record.session_id) && !store.pending.includes(record.session_id) && !store.done.includes(record.session_id)) store.pending.push(record.session_id);
          store.records.set(record.session_id, record);
        }
        store.cursor = page.next_after_id;
        more = page.has_more;
        setError("");
        setReady(true);
        publish();
      }
    } catch (caught) {
      if (!current()) return;
      if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) {
        clearScope();
      } else setError("新记录暂时没接回来。已有内容保留，连接恢复后会继续读取，不会重新提交已完成解读。");
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setReading(false);
    }
  }, [active, clearScope, config, deviceId, publish, store]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearInterval(timer); request.current?.abort(); request.current = null; };
  }, [active, refresh]);
  const settled = useCallback((result: DemoExplanationResult) => {
    if (store.pending[0] === result.session_id) setTerminal(result.session_id);
  }, [store]);
  const started = useCallback((sessionId: string) => {
    if (store.pending[0] === sessionId) setTerminal("");
  }, [store]);
  useEffect(() => {
    if (!active || document.hidden || !terminal || store.pending[0] !== terminal) return;
    const timer = window.setTimeout(() => {
      if (store.pending[0] !== terminal) return;
      store.pending.shift();
      store.done = [...store.done.filter(id => id !== terminal), terminal].slice(-20);
      store.selected = terminal;
      setTerminal(""); publish();
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [active, terminal, publish, store]);
  const currentId = store.pending[0] || store.selected || store.done.at(-1);
  const current = currentId ? store.records.get(currentId) : undefined;
  const hasCurrent = !!current;
  // Keep current permission and assignment fresh independently of the incoming feed.
  useEffect(() => {
    if (!active || !currentId || !hasCurrent) return;
    let live = true;
    let controller: AbortController | null = null;
    const verifyCurrent = async () => {
      if (!live || document.hidden || controller) return;
      const read = new AbortController(); controller = read;
      try {
        const record = await api.sessionById(config, currentId, read.signal);
        if (!live || read.signal.aborted || currentId !== (store.pending[0] || store.selected || store.done.at(-1))) return;
        if (record.session_id !== currentId || !isDemo(record, deviceId)) { unavailable(currentId, 404); return; }
        store.records.set(currentId, record); setRecordReadError(""); publish();
      } catch (caught) {
        if (!live || read.signal.aborted || currentId !== (store.pending[0] || store.selected || store.done.at(-1))) return;
        if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) unavailable(currentId, caught.status);
        else setRecordReadError("本条记录暂时未能复查，当前显示上次读取的内容；新记录仍会继续接收。");
      } finally { if (controller === read) controller = null; }
    };
    void verifyCurrent();
    const timer = window.setInterval(() => void verifyCurrent(), 5000);
    return () => { live = false; window.clearInterval(timer); controller?.abort(); };
    // The same record's refreshed object must not restart its timer or move reading focus.
  }, [active, config, currentId, deviceId, hasCurrent, publish, store, unavailable]);
  return <div className="demo-live-feed" data-demo-device={deviceId}>
    <p role="status" aria-label="设备接收状态">{!active ? "已暂停接收，回到这个页面后继续。" : error ? "连接暂未恢复。" : !ready ? "正在接回设备记录…" : reading ? "正在检查新记录…" : "正在接收 · 每 5 秒检查新记录"}</p>
    {error && <p role="alert">{error}<button type="button" onClick={() => { store.blocked = false; void refresh(); }}>重新接收记录</button></p>}
    {recordReadError && <p role="status" aria-label="本条记录复查状态">{recordReadError}</p>}
    {!current && ready && !error && <div className="demo-live-empty"><h2>设备就绪，等待这次测量。</h2><p>在采集程序开始手动测量并上传，不需要复制记录 ID。</p></div>}
    {current && <article className="demo-live-current" data-demo-session={current.session_id} aria-label="当前演示记录">
      <div className="demo-live-record-meta"><RecordSource record={current} /><span>{current.member_id ? `已归属：${current.member_id}` : "未认领 · 不归属任何当前成员"}</span></div>
      <ResultArrivalFrame key={current.session_id} className="demo-arrival" burst="收到啦！"
        visual={<DemoSampleVisual shape={current.raw_observations?.shape?.value} color={current.raw_observations?.color?.value} />}
        eyebrow="这条测量已到达" title="看到颜色，也看到形状。"
        description="形象来自本条上传的演示标签；缺失的信息仍然保持未知。"
        status="原始观测已收到，AI 解读在下方接着呈现" />
      <p className="demo-live-record-id">本条记录：<code>{current.session_id}</code></p>
      <p className="demo-live-queue-status">{store.pending.length > 1 ? `正在处理本条，后面还有 ${store.pending.length - 1} 条。会按到达顺序呈现。` : store.pending.length ? "正在接上这条记录的解读。" : "本条处理已结束，继续等待新记录。"}</p>
      <DemoExplanation config={config} sessionId={current.session_id} active={active && !error} autoGenerate={store.pending[0] === current.session_id} onSettled={settled} onPending={started} onUnavailable={unavailable} />
      <RecordObservations record={current} />
    </article>}
    {!!store.done.length && <details className="demo-live-history"><summary>本轮已处理 {store.done.length} 条</summary>
      {!!store.pending.length && <p>正在按序接收新记录，处理后可以回看。</p>}
      {store.done.map(id => <button key={id} type="button" disabled={!!store.pending.length} aria-pressed={currentId === id} onClick={() => { store.selected = id; publish(); }}>回看记录 {id}</button>)}
    </details>}
  </div>;
}
