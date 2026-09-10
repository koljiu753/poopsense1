import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ComposeDialog from "./ComposeDialog";
import NewRecordNotice from "./NewRecordNotice";
import { useAppNavigation, type View, type HealthSection } from "./useAppNavigation";
import { SensorSimulator } from "./SensorSimulator";
import {
  api,
  ApiError,
  type AgentAnalysisReport,
  type AgentAction as AgentActionRecord,
  type AgentConnection,
  type AgentMemory,
  type AgentProfile,
  type AgentProfileRevision,
  type AgentRun,
  type AgentStatus,
  type AppConfig,
  type CommunityPost,
  type Device,
  type Grant,
  type HealthProfile,
  type HealthActionFollowup,
  type InboxItem,
  type Member,
  type MemberSession,
  type PetSnapshot,
  type RawDataAuthorization,
  type Trend,
  type TrendDimension,
  type WeeklyHealthReport,
} from "./api";

const DEFAULT_CONFIG: AppConfig = {
  apiBase: import.meta.env.VITE_API_BASE
    ?? "",
  householdId: "hh_001",
  householdKey: "household-secret",
};
const CONFIG_STORAGE_KEY = "poopsense-config-v1";
function loadConfig(): AppConfig {
  try {
    const saved = {
      ...DEFAULT_CONFIG,
      ...JSON.parse(sessionStorage.getItem(CONFIG_STORAGE_KEY) ?? "{}"),
    };
    // Migrate the previous development default. On a phone, a loopback API
    // address points to the phone itself; an empty base uses the same-origin
    // Vite proxy instead.
    if (/^https?:\/\/(127\.0\.0\.1|localhost):8000$/i.test(saved.apiBase)) {
      saved.apiBase = "";
    }
    return saved;
  } catch {
    return DEFAULT_CONFIG;
  }
}
function friendlyError(error: unknown) {
  if (error instanceof ApiError && error.message === "REQUEST_TIMEOUT")
    return "等待服务响应超时，结果暂未确认。请先刷新查看是否已完成，再决定是否重试。";
  if (error instanceof ApiError && [401, 403].includes(error.status))
    return "当前账号无权查看这里，请检查家庭身份或授权。";
  if (error instanceof TypeError)
    return "暂时连不上 PoopSense，请检查网络后重试。";
  if (error instanceof ApiError && error.status === 404)
    return "暂时找不到这项内容，请刷新后再试。";
  return "加载失败，请稍后再试。";
}

function memberName(member: Member) {
  const demoNames: Record<string, string> = {
    "Owner profile": "Alex",
    "Second profile": "Sam",
  };
  return (
    demoNames[member.display_name] ??
    member.display_name.replace(/\s+profile$/i, "")
  );
}

export default function App() {
  const [config, setConfig] = useState(loadConfig);
  const navigation = useAppNavigation();
  const { route, navigate } = navigation;
  const view = route.view;
  const reportOrigin = navigation.origin ?? { view: "home" as const };
  function setView(next: View) { navigate({ view: next }); }
  const currentView = useRef(view);
  currentView.current = view;
  const [visitedViews, setVisitedViews] = useState<ReadonlySet<View>>(new Set(["home"]));
  useEffect(() => { setVisitedViews(previous => previous.has(view) ? previous : new Set([...previous, view])); }, [view]);
  const healthSection = route.section;
  function setHealthSection(section: HealthSection) { navigate({ view: "health", section }); }
  const requestedSource = route.sourceId;
  const [members, setMembers] = useState<Member[]>([]);
  const [membersReady, setMembersReady] = useState(false);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const selectedMember = route.memberId ? members.find(member => member.member_id === route.memberId)?.member_id ?? "" : members[0]?.member_id ?? "";
  const memberUnavailable = membersReady && !!route.memberId && !selectedMember;
  const [trend, setTrend] = useState<Trend | null>(null);
  const trendDays = route.trendDays;
  function setTrendDays(days: number) { navigate({ trendDays: days }, { preservePosition: true }); }
  const [sessionData, setSessionData] = useState<{ scope: string; items: MemberSession[] }>({ scope: "", items: [] });
  const memberScope = `${config.apiBase}:${config.householdId}:${selectedMember}`;
  const currentMemberScope = useRef(memberScope);
  currentMemberScope.current = memberScope;
  const sessions = sessionData.scope === memberScope ? sessionData.items : [];
  function setSessions(items: MemberSession[]) { setSessionData({ scope: memberScope, items }); }
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [recordsError, setRecordsError] = useState("");
  const [trendError, setTrendError] = useState("");
  const [dataRefreshVersion, setDataRefreshVersion] = useState(0);
  const [pendingResults, setPendingResults] = useState<MemberSession[]>([]);
  const hasPendingResults = useRef(false);
  hasPendingResults.current = pendingResults.length > 0;
  const pendingResult = pendingResults.find(item => item.risk_level === "redline") ?? pendingResults[0];
  const doctorAutoSession = sessions.find(session => session.session_id === route.sessionId);
  const resultSession = doctorAutoSession;
  const visitedReport = useRef("");
  const reportKey = `${memberScope}:${route.sessionId}`;
  if (view === "doctor" && doctorAutoSession) visitedReport.current = reportKey;
  function openReport(session?: MemberSession) {
    navigate({ view: "doctor", sessionId: session?.session_id ?? "", memberId: selectedMember, chat: !session });
  }
  function returnFromReport() {
    navigation.back(navigation.origin ?? { view: "health", section: "records", sessionId: "" });
  }
  function openActionHistory() {
    navigate({ view: "health", section: "actions", sourceId: doctorAutoSession?.session_id ?? "" });
  }
  function openPendingResult() {
    if (!pendingResult) return;
    setPendingResults(current => current.filter(item => item.session_id !== pendingResult.session_id));
    navigate({ view: "result", sessionId: pendingResult.session_id });
  }
  function retryMemberData() { setDataRefreshVersion(version => version + 1); }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sessionFeedReady = useRef(false);
  const lastObservedSession = useRef<string | undefined>(undefined);
  const feedRevision = useRef(0);
  const observedSessions = useRef(new Set<string>());
  useEffect(() => {
    if (selectedMember && !route.memberId) navigate({ memberId: selectedMember }, { replace: true, preservePosition: true });
  }, [selectedMember, route.memberId, navigate]);
  // Browser history can switch members too; clear stale UI before painting the next scope.
  useLayoutEffect(() => {
    feedRevision.current += 1;
    setSessions([]);
    setRecordsLoading(true);
    setRecordsError("");
    setTrendError("");
    setPendingResults([]);
    setTrend(null);
  }, [selectedMember, config]);
  useEffect(() => {
    const titles = { home: "首页", health: { records: "健康记录", actions: "行动回看", trends: "长期趋势" }[healthSection], social: "广场", settings: "我的", doctor: "记录报告", result: "新记录" };
    document.title = `${titles[view]} · PoopSense`;
  }, [view, healthSection]);
  const coreRevision = useRef(0);
  const refreshCore = useCallback(async () => {
    const revision = ++coreRevision.current;
    setBusy(true);
    setError("");
    try {
      const [nextMembers, nextInbox] = await Promise.all([
        api.members(config),
        api
          .inbox(config)
          .catch((caught) =>
            caught instanceof ApiError && caught.status === 403
              ? []
              : Promise.reject(caught),
          ),
      ]);
      if (revision !== coreRevision.current) return;
      setMembers(nextMembers);
      setInbox(nextInbox);
      setMembersReady(true);
    } catch (caught) {
      if (revision === coreRevision.current) setError(friendlyError(caught));
    } finally {
      if (revision === coreRevision.current) setBusy(false);
    }
  }, [config]);
  useEffect(() => {
    void refreshCore();
    return () => { coreRevision.current += 1; };
  }, [refreshCore]);
  useEffect(() => {
    if (!selectedMember) return;
    setRecordsLoading(true);
    setRecordsError("");
    let active = true;
    let loading = false;
    sessionFeedReady.current = false;
    lastObservedSession.current = undefined;
    observedSessions.current = new Set();
    const refreshMemberData = async () => {
      if (loading) return;
      loading = true;
      const revision = feedRevision.current;
      try {
        const nextSessions = await api.sessions(config, selectedMember);
        if (!active || revision !== feedRevision.current) return;
        setSessions(nextSessions);
        setPendingResults(current => current.flatMap(item => {
          const available = nextSessions.find(record => record.session_id === item.session_id);
          return available ? [available] : [];
        }));
        setRecordsLoading(false);
        setRecordsError("");
        const newest = nextSessions[0];
        if (!sessionFeedReady.current) {
          sessionFeedReady.current = true;
          lastObservedSession.current = newest?.session_id;
          nextSessions.forEach(item => observedSessions.current.add(item.session_id));
          return;
        }
        const isNew = newest && !observedSessions.current.has(newest.session_id);
        const newRecords = nextSessions.filter(item => !observedSessions.current.has(item.session_id));
        nextSessions.forEach(item => observedSessions.current.add(item.session_id));
        if (newest && isNew) {
          lastObservedSession.current = newest.session_id;
          if (!hasPendingResults.current && ["home", "doctor", "result"].includes(currentView.current)) {
            setPendingResults(current => current.filter(item => item.session_id !== newest.session_id));
            navigate({ view: "result", sessionId: newest.session_id }, { replace: ["doctor", "result"].includes(currentView.current) });
          } else setPendingResults(current => [...current, ...newRecords.filter(item => !current.some(record => record.session_id === item.session_id))]);
        }
      } catch (caught) {
        if (active && revision === feedRevision.current) { setRecordsError(friendlyError(caught)); setRecordsLoading(false); }
      } finally {
        loading = false;
      }
    };
    void refreshMemberData();
    const poll = window.setInterval(() => void refreshMemberData(), 5000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [config, selectedMember, dataRefreshVersion, navigate]);
  useEffect(() => {
    if (!selectedMember) return;
    let active = true;
    let loading = false;
    setTrendError("");
    setTrend(null);
    const refreshTrend = async () => {
      if (loading) return;
      loading = true;
      const revision = feedRevision.current;
      try {
        const next = await api.trend(config, selectedMember, trendDays);
        if (active && revision === feedRevision.current) { setTrend(next); setTrendError(""); }
      } catch (caught) {
        if (active && revision === feedRevision.current) setTrendError(friendlyError(caught));
      } finally { loading = false; }
    };
    void refreshTrend();
    const poll = window.setInterval(() => void refreshTrend(), 5000);
    return () => { active = false; window.clearInterval(poll); };
  }, [config, selectedMember, trendDays, dataRefreshVersion]);
  async function assign(
    sessionId: string,
    memberId: string,
    correction = false,
  ) {
    setBusy(true);
    setError("");
    try {
      await api.claim(config, sessionId, memberId, correction);
      await refreshCore();
      const [nextTrend, nextSessions] = await Promise.all([
        api.trend(config, selectedMember, trendDays),
        api.sessions(config, selectedMember),
      ]);
      setTrend(nextTrend);
      setSessions(nextSessions);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }
  const selected = members.find((item) => item.member_id === selectedMember);
  const selectedName = selected ? memberName(selected) : "你";
  function selectMember(memberId: string) {
    if (memberId === selectedMember) return;
    navigate({ memberId, sessionId: "", sourceId: "" }, { preservePosition: true });
  }
  const nav = [
    { id: "home" as const, icon: "⌂", label: "首页" },
    { id: "health" as const, icon: "↗", label: "健康", count: inbox.length },
    { id: "social" as const, icon: "✦", label: "广场" },
    { id: "settings" as const, icon: "◎", label: "我的" },
  ];
  return (
    <div className={`app-shell experience view-${view}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("home")}>
          <span className="brand-mark">✦</span>
          <span>
            <b>POOPSENSE</b>
            <small>SEE. SMELL. SENSE.</small>
          </span>
        </button>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <NavButton
              key={item.id}
              {...item}
              active={view === item.id || view === "doctor" && reportOrigin.view === item.id}
              onClick={() => setView(item.id)}
            />
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar">{selectedName.slice(0, 1)}</span>
          <span>
            <b>{selectedName}</b>
            <small>家庭健康空间</small>
          </span>
        </div>
      </aside>
      <div className="content-shell">
        <header className="topbar">
          <div>
            <b>
              {view === "home"
                ? "便知 · PoopSense"
                : view === "result"
                  ? "NEW SIGNAL"
                : (
                    {
                      health: "记录与回看",
                      doctor: "这次的身体信号",
                      social: "便便岛 · 一起聊聊",
                      settings: "我的 · PoopSense",
                    } as const
                  )[view]}
            </b>
            <small>每一次信号，都值得被温柔读懂</small>
          </div>
          <span className={`service-dot ${error ? "offline" : ""}`}>
            {error ? "连接异常" : busy ? "连接中" : "服务已连接"}
          </span>
        </header>
        <main className={view === "home" ? "home-main" : undefined}>
          {pendingResult && view !== "doctor" && view !== "result" && <NewRecordNotice memberName={selectedName} pendingCount={pendingResults.length} occurredAt={pendingResult.occurred_at} simulated={Boolean(pendingResult.simulated)} urgent={pendingResult.risk_level === "redline"} onOpen={openPendingResult} onDismiss={() => setPendingResults(current => current.filter(item => item.session_id !== pendingResult.session_id))} />}
          {error && (
            <div className="alert" role="alert">
              <span>!</span>
              {error}
              <button onClick={() => void refreshCore()}>重试</button>
            </div>
          )}
          {memberUnavailable ? <section className="page route-unavailable" role="alert"><h1>这个成员暂时无法查看</h1><p>当前家庭中没有这个成员，或查看权限已经变化。请选择可查看的成员继续。</p><button onClick={() => navigate({ view: "home", memberId: members[0]?.member_id ?? "", sessionId: "", sourceId: "" }, { replace: true })}>回到当前家庭</button></section> : <>
          {(view === "home" || visitedViews.has("home")) && (<div hidden={view !== "home"}>
            <Home
              active={view === "home"}
              config={config} sessions={sessions} members={members} selected={selectedMember} loading={recordsLoading} recordsError={recordsError} onRetry={retryMemberData}
              onRecord={openReport}
              onSelect={selectMember} inboxCount={inbox.length}
              onHistory={() => navigate({ view: "health", section: "records" })}
              onDoctor={() => openReport(sessions[0])}
            />
          </div>)}
          {view === "home" && selectedMember && (
            <SensorSimulator key={`${config.apiBase}:${config.householdId}:${selectedMember}`} config={config} memberId={selectedMember}
              onReceived={async (sessionId, pending) => {
                if (currentMemberScope.current !== memberScope || currentView.current !== "home") return;
                feedRevision.current += 1;
                await refreshCore();
                if (currentMemberScope.current !== memberScope || currentView.current !== "home") return;
                if (pending) { navigate({ view: "health", section: "records" }); return; }
                const nextSessions = await api.sessions(config, selectedMember);
                if (currentMemberScope.current !== memberScope || currentView.current !== "home") return;
                const result = nextSessions.find(item => item.session_id === sessionId);
                if (!result) throw new Error("Received result not visible yet");
                lastObservedSession.current = sessionId;
                observedSessions.current.add(sessionId);
                sessionFeedReady.current = true;
                setSessions(nextSessions);
                setPendingResults(current => current.filter(item => item.session_id !== result.session_id));
                navigate({ view: "result", sessionId: result.session_id });
              }} />
          )}
          {view !== "home" && (view === "doctor" ? doctorAutoSession : view === "result" ? resultSession : sessions[0])?.simulated && <div className="simulation-label">模拟记录 · 用于体验，不代表真实检测结果</div>}
          {view === "result" && resultSession && (
            <ResultArrival
              session={resultSession}
              onComplete={() => {
                navigate({ view: "doctor" }, { replace: true });
              }}
            />
          )}
          {(view === "doctor" && !route.chat || view === "result") && !doctorAutoSession && <section className="page route-unavailable" role={recordsLoading || !membersReady ? "status" : "alert"}>
            <h1>{recordsLoading || !membersReady ? "正在找到这条记录" : recordsError ? "这条记录暂时没接回来" : "暂时无法查看这条记录"}</h1>
            <p>{recordsLoading || !membersReady ? "确认成员和记录后，会接着打开报告。" : recordsError ? friendlyError(new TypeError()) : "记录可能已重新归属，或当前成员已无法查看。可以回记录册选择其他记录。"}</p>
            {recordsError && <button onClick={retryMemberData}>重试读取记录</button>}<button onClick={() => navigate({ view: "health", section: "records", sessionId: "" }, { replace: true })}>回到记录册</button>
          </section>}
          {view === "doctor" && selectedMember && (route.chat || doctorAutoSession || visitedReport.current === reportKey) && (<div hidden={!route.chat && !doctorAutoSession}>
            <AgentDoctor
              key={`${config.apiBase}:${config.householdId}:${selectedMember}`}
              config={config}
              memberId={selectedMember}
              name={selectedName}
              latestSession={doctorAutoSession}
              autoSession={doctorAutoSession}
              onBack={returnFromReport}
              onHistory={openActionHistory}
            />
          </div>)}
          {selectedMember && (view === "health" || visitedViews.has("health")) && (<div hidden={view !== "health"}>
            <Health
              active={view === "health"} section={healthSection} onSection={setHealthSection} requestedSource={requestedSource} onSourceChange={sourceId => navigate({ sourceId }, { preservePosition: true })}
              key={`${config.apiBase}:${config.householdId}:${selectedMember}`}
              config={config}
              inbox={inbox}
              members={members}
              selected={selectedMember}
              onSelect={selectMember}
              trend={trend}
              trendDays={trendDays}
              onTrendDaysChange={setTrendDays}
              sessions={sessions}
              recordsLoading={recordsLoading} recordsError={recordsError} trendError={trendError} onRetry={retryMemberData}
              busy={busy}
              onAssign={assign}
              onOpenReport={openReport}
            />
          </div>)}
          {selectedMember && (view === "social" || visitedViews.has("social")) && <div hidden={view !== "social"}><Social key={`${config.apiBase}:${config.householdId}:${selectedMember}`} config={config} memberId={selectedMember} active={view === "social"} /></div>}
          {selectedMember && (view === "settings" || visitedViews.has("settings")) && (<div hidden={view !== "settings"}>
            <Settings
              key={`${config.apiBase}:${config.householdId}:${selectedMember}`}
              active={view === "settings"}
              config={config}
              members={members}
              selectedMember={selectedMember}
              onMembersChanged={() => void refreshCore()}
              onSave={(next) => {
                sessionStorage.setItem(
                  CONFIG_STORAGE_KEY,
                  JSON.stringify(next),
                );
                setMembers([]);
                setMembersReady(false);
                setConfig(next);
                navigate({ view: "home", memberId: "", sessionId: "", sourceId: "" }, { replace: true });
              }}
            />
          </div>)}
          </>}
        </main>
      </div>
      <nav className="bottom-nav" aria-label="移动端主导航">
        {nav.map((item) => (
          <NavButton
            key={item.id}
            {...item}
            active={view === item.id || view === "doctor" && reportOrigin.view === item.id}
            onClick={() => setView(item.id)}
          />
        ))}
      </nav>
    </div>
  );
}
function NavButton({
  active,
  label,
  count,
  onClick,
  icon,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
  icon: string;
}) {
  return (
    <button className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={onClick}>
      <span className="nav-icon">
        {icon}
        {count ? <i>{count}</i> : null}
      </span>
      <span>{label}</span>
    </button>
  );
}

const POOP_VISUALS = {
  compact: { asset: "/poop-shape-compact-yellow-v2.webp", label: "紧实成团" },
  elongated: { asset: "/poop-shape-elongated-yellow-v2.webp", label: "顺滑长条" },
  scattered: { asset: "/poop-shape-scattered-yellow-v2.webp", label: "分散颗粒" },
  irregular: { asset: "/poop-shape-irregular-yellow-v2.webp", label: "不规则形态" },
  uncertain: { asset: "/poopsense-mascot-pop-v1.webp", label: "等待可靠判断" },
} as const;

function sessionVisual(session?: MemberSession) {
  const profile = session?.visual_profile;
  const variant = profile?.reliable ? profile.variant : "uncertain";
  return { ...POOP_VISUALS[variant], variant, profile };
}

function Home({
  sessions,
  inboxCount,
  onDoctor,
  members, selected, onSelect, onHistory, loading, config, onRecord, active, recordsError, onRetry,
}: {
  sessions: MemberSession[];
  inboxCount: number;
  onDoctor: () => void;
  members: Member[]; selected: string; onSelect: (id: string) => void; onHistory: () => void;
  loading: boolean;
  config: AppConfig; onRecord: (session: MemberSession) => void;
  active: boolean;
  recordsError: string; onRetry: () => void;
}) {
  const latest = sessions[0];
  const visual = sessionVisual(latest);
  const person = members.find(member => member.member_id === selected);
  const displayName = person ? memberName(person) : "你";
  const [savedChoice, setSavedChoice] = useState<HealthActionFollowup | null>(null);
  const latestId = latest?.session_id;
  useEffect(() => {
    let live = true;
    if (latestId && selected && active) {
      void api.actionFollowups(config, selected).then(items => {
        if (live) setSavedChoice(items.find(item => item.source_session_id === latestId && item.adoption_status !== "suggested") ?? null);
      }).catch(() => { /* Optional saved choice never blocks the record itself. */ });
    }
    return () => { live = false; };
  }, [config, selected, latestId, active]);
  const visibleChoice = savedChoice?.member_id === selected && savedChoice.source_session_id === latestId ? savedChoice : null;
  const showCompanionReply = visibleChoice && latest?.risk_level !== "redline" && visual.profile?.reliable;
  const state = useMemo(() => {
    if (!latest && recordsError) return { tag: "暂未读到", title: "记录暂时没接回来", copy: "连接恢复后就能继续查看，接着查看最近一次结果。", mark: "WAIT" };
    if (!latest && loading) return { tag: "正在读取", title: "正在接回你的记录", copy: "稍等片刻，确认这个成员最近一次的身体信号。", mark: "WAIT" };
    if (!latest)
      return {
        tag: "等待新记录",
        title: "从第一条记录，认识自己",
        copy: "这里还没有已认领记录。你可以先体验下方模拟检测，了解结果会怎样呈现。",
        mark: "READY",
      };
    if (latest.risk_level === "redline")
      return {
        tag: "需要留意",
        title: "这次信号，需要优先处理",
        copy: "请优先寻求专业帮助，打开结果查看安全提醒。",
        mark: "CHECK",
      };
    if (latest.visual_profile?.reliable === false || /无法可靠判断/.test(latest.message))
      return {
        tag: "数据不足",
        title: "这一次还看不清",
        copy: "本次无法可靠判断，PoopSense 不会给出模糊结论。",
        mark: "PAUSE",
      };
    if (["hard", "compact", "scattered"].includes(latest.visual_profile?.shape?.value ?? ""))
      return { tag: "这次偏干", title: "有点干，照顾一下自己", copy: latest.message, mark: "CARE" };
    if (["loose", "watery", "irregular"].includes(latest.visual_profile?.shape?.value ?? ""))
      return { tag: "这次偏稀", title: "放慢一点，留意接下来的变化", copy: latest.message, mark: "CARE" };
    return {
      tag: "这次的记录",
      title: visual.profile?.reliable ? "这一回，成形的一小条" : "这次记录，来看看吧",
      copy: visual.profile?.reliable ? "这一页已经收好，看看这次的观察和建议吧。" : latest.message || "打开本次分析，了解这次记录。",
      mark: "GOOD",
    };
  }, [latest, loading, recordsError]);
  return (
    <section className="page home-page">
      <div className="home-member">
        <div><small>POOP DIARY</small><h1>{displayName} 的便便日记</h1></div>
        <label><span>当前成员</span><select aria-label="首页查看哪位成员" value={selected} onChange={event => onSelect(event.target.value)}>
          {members.map(member => <option key={member.member_id} value={member.member_id}>{memberName(member)}</option>)}
        </select></label>
      </div>
      <article className={`hero-card signal-${latest?.risk_level === "redline" ? "urgent" : visual.variant === "uncertain" ? "uncertain" : "ready"}`}>
        <div className="record-context">
          <span>{latest ? "最近一次记录" : loading ? "正在读取记录" : "还没有记录"} · {displayName}</span>
          {latest ? <time dateTime={latest.occurred_at}>{new Date(latest.occurred_at).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time> : null}
          {latest?.simulated ? <small>模拟记录 · 不代表真实检测</small> : null}
        </div>
        <div className="hero-copy">
          <div className="status-line">
            <span>{state.tag}</span>
          </div>
          <h2>{state.title}</h2>
          <p>{showCompanionReply ? visibleChoice.adoption_status === "skipped" ? "没关系，这次先放下。你的选择已经留在这一页。" : visibleChoice.adoption_status === "completed" ? "感受收到了。我会把它和这次观察一起留着。" : "好，替你记下了。下一次记录到了，我们再一起看看。" : state.copy}</p>
        </div>
        <div className="hero-art">
          <span className="scene-lettering" aria-hidden="true">{latest?.risk_level === "redline" ? "TAKE CARE" : visual.variant === "uncertain" ? "HOLD ON" : "HELLO, BODY!"}</span>
          <div className="scene-platform" aria-hidden="true" />
          <img
            src={visual.asset}
            alt={`传感器映射的便便卡通形象：${visual.label}`}
            data-visual-variant={visual.variant}
          />
          <small>{visual.profile?.reliable ? visual.label : "等待可靠记录 · 暂不作健康判断"}</small>
        </div>
        <div className="hero-actions scene-action">
          {visibleChoice ? <p className="scene-choice"><b>✓ {visibleChoice.adoption_status === "skipped" ? "已记下：暂不采用" : visibleChoice.adoption_status === "completed" ? "已记下你的感受" : "已记下：准备试试"}</b><small>这是你的选择，不代表健康变化</small></p> : <p className="scene-invitation">{latest?.risk_level === "redline" ? "先看安全提醒，再决定下一步" : "这次发生了什么，一起看看"}</p>}
          <button className="comic-button" disabled={!latest && loading} onClick={!latest && recordsError ? onRetry : onDoctor}>
            {latest ? "看看这次结果 →" : loading ? "正在读取记录…" : recordsError ? "重试读取记录" : "了解如何开始 →"}
          </button>
        </div>
      </article>
      {recordsError && <div className="record-load-error" role="alert"><span>{latest ? "新记录暂时未更新，当前显示上次读取的内容。" : "暂时无法读取记录。"}{recordsError}</span>{latest && <button onClick={onRetry}>重试读取记录</button>}</div>}
      {sessions.length > 1 ? <div className="diary-recent" aria-label="最近的记录足迹"><b>之前的小足迹</b><div>{sessions.slice(1, 4).map(item => <button key={item.session_id} onClick={() => onRecord(item)} aria-label={`打开${new Date(item.occurred_at).toLocaleString("zh-CN")}的记录`}>
        <img src={sessionVisual(item).asset} alt="" /><span>{new Date(item.occurred_at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}<small>{item.risk_level === "redline" ? "需重视" : sessionVisual(item).label}</small></span>
      </button>)}</div></div> : null}
      <div className="home-next">
        <button onClick={onHistory}><span>记录与行动回看<small>看看上次的选择与后续变化</small></span><span aria-hidden="true">→</span></button>
        {inboxCount ? <button className="pending-link" onClick={onHistory}><span>{inboxCount} 次记录待确认<small>确认是谁的记录后，再作个人分析</small></span><span aria-hidden="true">→</span></button> : null}
      </div>
    </section>
  );
}

function ResultArrival({
  session,
  onComplete,
}: {
  session: MemberSession;
  onComplete: () => void;
}) {
  const visual = sessionVisual(session);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => completeRef.current(), reduced ? 0 : 2200);
    return () => window.clearTimeout(timer);
  }, [session.session_id]);
  return (
    <section className="result-arrival" data-risk={session.risk_level} aria-live="polite">
      <div className="result-burst" aria-hidden="true">新记录</div>
      <img
        src={visual.asset}
        alt={`PoopSense 正在读取新的身体信号：${visual.label}`}
        data-visual-variant={visual.variant}
      />
      <div className="result-arrival-copy">
        <small>检测到新的身体信号</small>
        <h1>收到，这次交给我。</h1>
        <p>{session.message}</p>
        <span><i /> 记录已收到，即将打开分析</span>
      </div>
      <button onClick={onComplete}>跳过动画</button>
    </section>
  );
}

function sessionAdvicePrompt(session: MemberSession) {
  const hydrationInstruction = /一颗颗|干硬|偏硬/.test(session.message)
    ? "这是一条偏干硬信号，请结合本次记录给出清楚、克制的生活方式建议，并说明下一次值得观察的变化。"
    : "";
  return `请解释我最近一次记录：时间 ${session.occurred_at}，风险级别 ${session.risk_level}，可靠结论：${session.message}。${hydrationInstruction}请先解释这意味着什么，再告诉我今天最值得做的一件事；不要做医疗诊断。`;
}

const adviceIcons: Record<AgentAnalysisReport["recommendations"][number]["category"], string> = {
  hydration: "💧",
  diet: "🥬",
  movement: "↗",
  observation: "◎",
  care: "+",
};

function AnalysisReport({
  report,
  followup,
  onUpdateFollowup,
  savingFollowup,
  feedbackError, onHistory, session,
}: {
  report: AgentAnalysisReport;
  followup: HealthActionFollowup | null;
  savingFollowup: boolean;
  feedbackError: string; onHistory: () => void;
  session?: MemberSession;
  onUpdateFollowup: (update: Partial<Pick<HealthActionFollowup, "adoption_status" | "perceived_outcome">>) => void;
}) {
  const statusLabel = {
    ready: "分析完成",
    insufficient: "等待可靠数据",
    urgent: "优先处理",
  }[report.status];
  const character = session?.session_id === report.session_id ? sessionVisual(session) : sessionVisual();
  const choiceSaved = followup && followup.adoption_status !== "suggested";
  // Followup timestamps are stored in UTC; SQLite may omit the offset when reading them back.
  const savedTimestamp = followup?.updated_at;
  const savedAt = savedTimestamp
    ? new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(savedTimestamp) ? savedTimestamp : `${savedTimestamp}Z`)
    : null;
  const shapeObservation = report.status === "ready" && report.reliable
    ? report.findings.find(finding => finding.dimension === "shape")
    : undefined;
  const companionReply = savingFollowup ? "正在替你记下…" : choiceSaved
    ? followup.adoption_status === "skipped" ? "好，这次先放下。选择也会留在这一页。" : followup.adoption_status === "completed" ? "感受收到了，下次我们接着看。" : "记下啦。下一次有记录，我们接着看看。"
    : "";
  return (
    <section className={`analysis-report ${report.status} ${choiceSaved ? "choice-saved" : ""}`} aria-labelledby="analysis-report-title">
      <header>
        <div className="report-character"><img src={character.asset} alt={`这次记录的形象：${character.label}`} /><span>{report.status === "urgent" ? "!" : report.status === "insufficient" ? "?" : "这次的我"}</span></div>
        <div className="report-speech">
          <small>{shapeObservation ? "这次的形态" : statusLabel}</small>
          <h2 id="analysis-report-title">{shapeObservation ? shapeObservation.value : report.headline}</h2>
          {!shapeObservation && <p>{report.summary}</p>}
          {report.status === "ready" && companionReply && <p className="companion-reply" role="status">{companionReply}</p>}
        </div>
        <span className="report-stamp">{statusLabel}</span>
      </header>
      <div className="recommendation-grid" aria-label="多方面建议">
        {report.recommendations.map((item, index) => {
          const card = (
          <article className={item.category} key={`${item.category}:${item.title}`}>
            <span aria-hidden="true">{adviceIcons[item.category]}</span>
            <div>
              <small>{index === 0 && report.status === "ready" ? "先从这一件事开始" : item.timing === "now" ? "现在" : item.timing === "today" ? "今天" : "下次留意"}</small>
              <b>{item.title}</b>
              <p>{item.guidance}</p>
            </div>
          </article>
          );
          return index === 0 || report.status !== "ready" ? card : null;
        })}

      </div>
      {report.status === "ready" && report.followup_id ? (
        <section className="report-followup" aria-label="记录这次行动">
          {savingFollowup && <p role="status">正在保存你的选择…</p>}
          {feedbackError && <p className="feedback-error" role="alert">选择尚未确认保存。{feedbackError} 你可以再次点击原来的选择。</p>}
          <div>
            <small>{choiceSaved ? "✓ 这一页，记下了" : "给这次记录留一句回应"}</small>
            <b>{followup?.adoption_status === "completed" ? "已记下你的感受" : followup?.adoption_status === "accepted"
              ? "已保存你的意向"
              : followup?.adoption_status === "skipped"
                ? "这次先不采用，也已如实记录"
                : "准备从这项建议开始吗？"}</b>
            <p>只记录你的选择，不代表已经执行或产生效果。</p>
          </div>
          {followup && followup.adoption_status !== "suggested" ? <button className="feedback-history" onClick={onHistory}>查看行动记录 →</button> : null}
          <div className="report-followup-actions">
            <button
              type="button"
              aria-pressed={followup?.adoption_status === "accepted"}
              disabled={savingFollowup}
              onClick={() => onUpdateFollowup({ adoption_status: "accepted" })}
            >
              今天会试试
            </button>
            <button
              type="button"
              aria-pressed={followup?.adoption_status === "skipped"}
              disabled={savingFollowup}
              onClick={() => onUpdateFollowup({ adoption_status: "skipped" })}
            >
              暂不采用
            </button>
          </div>
          {choiceSaved && savedAt ? <time className="choice-saved-time" dateTime={savedAt.toISOString()}>保存于 {savedAt.toLocaleString("zh-CN")}</time> : null}
        </section>
      ) : null}
        {report.status === "ready" && report.recommendations.length > 1 ? <details className="more-advice">
          <summary>其他可选建议（{report.recommendations.length - 1}）</summary>
          {report.recommendations.slice(1).map(item => <article key={`${item.category}:${item.title}`}>
            <div><b>{item.title}</b><p>{item.guidance}</p></div>
          </article>)}
        </details> : null}
      <footer>
        <b>接下来</b>
        <span>{report.next_step}</span>
      </footer>
      <details className="report-evidence">
        <summary>这次看到了什么 · 查看依据与局限</summary>
      {shapeObservation && <p>{report.summary}</p>}
      {report.findings.length ? (
        <div className="analysis-findings" aria-label="本次可靠传感结果">
          {report.findings.map((finding) => (
            <div key={finding.dimension}>
              <small>{finding.label}</small>
              <b>{finding.value}</b>
              <span>可靠度 {Math.round(finding.confidence * 100)}%</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="analysis-collaboration" aria-label="自动分析进度">
        <span>{report.reliable ? "✓ 传感结果已整理" : "! 传感信息待补充"}</span>
        <span>✓ 数据质量已检查</span>
        {report.status === "ready" ? <span>✓ 今日行动已整理</span> : null}
        <span>✓ 安全规则已检查</span>
      </div>
      <p className="report-disclaimer">自动生成的健康参考，未经真人医生审核，不作为医疗诊断。</p>
      </details>
    </section>
  );
}

type ChatMessage = {
  historical?: boolean;
  role: "doctor" | "user";
  text: string;
  messageId?: number;
  feedback?: "helpful" | "not_helpful";
};
function AgentDoctor({
  config,
  memberId,
  name,
  latestSession,
  autoSession,
  onBack,
  onHistory,
}: {
  config: AppConfig;
  memberId: string;
  name: string;
  latestSession?: MemberSession;
  autoSession?: MemberSession;
  onBack: () => void;
  onHistory: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "doctor",
      text: `你好，${name}。我是 PoopSense Agent 医生。我可以结合已认领记录解释身体信号，但不替代医生诊断。`,
    },
  ]);
  const [conversationId, setConversationId] = useState<string>();
  const [historyReady, setHistoryReady] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [sending, setSending] = useState(false);
  const sendBusy = useRef(false);
  const [failedSessionId, setFailedSessionId] = useState<string>();
  const [chatError, setChatError] = useState("");
  const [detailWarning, setDetailWarning] = useState("");
  const [delegation, setDelegation] = useState("");
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [analysisReport, setAnalysisReport] = useState<AgentAnalysisReport | null>(null);
  const [followup, setFollowup] = useState<HealthActionFollowup | null>(null);
  const [savingFollowup, setSavingFollowup] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const followupBusy = useRef(false);
  const feedbackRevision = useRef(0);
  const autoTriggeredSession = useRef<string | undefined>(undefined);
  const responseRevision = useRef(0);
  useEffect(() => {
    let active = true;
    const revision = ++responseRevision.current;
    const initialFeedbackRevision = feedbackRevision.current;
    setAnalysisReport(null);
    setFollowup(null);
    setHistoryReady(false);
    setConversationId(undefined);
    setMessages([]);
    setAgentStatus(null);
    setAgentRun(null);
    setDelegation("");
    setDetailWarning("");
    if (!memberId)
      return () => {
        active = false;
      };
    void api.agentStatus(config).then((status) => {
      if (active) setAgentStatus(status);
    }).catch(() => {
      if (active && revision === responseRevision.current)
        setDetailWarning("部分状态或跟进信息暂时未加载，历史对话仍可查看。");
    });
    const followupsPromise = api.actionFollowups(config, memberId).catch(() => {
        if (active && revision === responseRevision.current) {
          setDetailWarning("部分状态或跟进信息暂时未加载，历史对话仍可查看。");
        }
        return [];
    });
    api.conversations(config, memberId)
      .then(async (conversations) => {
        if (!active) return;
        const latest = conversations[0];
        if (!latest) {
          setHistoryReady(true);
          return;
        }
        const history = await api.conversation(config, latest.conversation_id);
        if (!active) return;
        setConversationId(history.conversation_id);
        const previousAnalysis = [...history.messages]
          .reverse()
          .find((item) => item.role === "assistant" && item.metadata?.report);
        if (previousAnalysis?.metadata?.report) {
          const restoredReport = previousAnalysis.metadata.report;
          setAnalysisReport(restoredReport);
          void followupsPromise.then((followups) => {
            if (!active || revision !== responseRevision.current || initialFeedbackRevision !== feedbackRevision.current) return;
            const restoredFollowup = followups.find(
            (item) => item.source_session_id === restoredReport.session_id,
          ) ?? null;
          setAnalysisReport({
            ...restoredReport,
            followup_id: restoredReport.followup_id ?? restoredFollowup?.followup_id,
          });
          setFollowup(restoredFollowup);
          });
        }
        setMessages(
          history.messages.filter((item) => item.role !== "event").map((item) => ({
            historical: true,
            role: item.role === "assistant" ? "doctor" : "user",
            text: item.content,
            messageId: item.role === "assistant" ? item.message_id : undefined,
          })),
        );
        setHistoryReady(true);
      })
      .catch((caught) => {
        if (active) {
          setDetailWarning(`历史对话暂时未加载：${friendlyError(caught)}。本次分析仍可继续。`);
          setHistoryReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [config, memberId]);
  async function send(
    text = draft,
    options?: { session?: MemberSession; showUser?: boolean },
  ) {
    const clean = text.trim();
    if ((!clean && !options?.session) || !memberId || !historyReady || sending || sendBusy.current) return;
    sendBusy.current = true;
    responseRevision.current += 1;
    setFailedSessionId(undefined);
    if (options?.session) {
      setFeedbackError("");
      setMessages((current) => current.map((message) => ({ ...message, historical: true })));
      setAnalysisReport(null);
      setFollowup(null);
      setAgentRun(null);
      setDelegation("");
    }
    if (options?.showUser ?? !options?.session) {
      setMessages((current) => [...current, { role: "user", text: clean }]);
    }
    setDraft("");
    setSending(true);
    setChatError("");
    setDetailWarning("");
    try {
      const result = options?.session
        ? await api.analyzeSession(
            config, memberId, options.session.session_id, conversationId,
          )
        : await api.agentChat(config, memberId, clean, conversationId);
      setConversationId(result.conversation_id);
      // Plain follow-up answers keep the record's report and saved response.
      if (result.report) {
        setAnalysisReport(result.report);
        setFollowup(null);
      }
      setDelegation(`${agentRoleLabel(result.delegated_agent)} · ${skillLabel(result.skill)}`);
      setAgentRun(null);
      if (!result.report) {
        setMessages((current) => [
          ...current,
          { role: "doctor", text: result.message.content, messageId: result.message.message_id },
        ]);
      }
      // Optional details must not discard a successfully received response.
      const detailFeedbackRevision = feedbackRevision.current;
      const [followupResult, runResult] = await Promise.allSettled([
        result.report?.followup_id ? api.actionFollowups(config, memberId) : Promise.resolve([]),
        api.agentRun(config, result.run_id),
      ]);
      if (result.report && followupResult.status === "fulfilled" && detailFeedbackRevision === feedbackRevision.current) {
        setFollowup(followupResult.value.find((item) => item.followup_id === result.report?.followup_id) ?? null);
      }
      if (runResult.status === "fulfilled") setAgentRun(runResult.value);
      if (followupResult.status === "rejected" || runResult.status === "rejected") {
        setDetailWarning("回复已生成，部分跟进信息暂时未加载。你可以继续阅读，稍后重新打开查看。");
      }
    } catch (caught) {
      if (options?.session) setFailedSessionId(options.session.session_id);
      setChatError(
        caught instanceof ApiError && caught.message === "MODEL_NOT_CONFIGURED"
          ? "对话服务暂未连接。你仍可查看记录的基础报告，稍后再来提问。"
          : friendlyError(caught),
      );
    } finally {
      sendBusy.current = false;
      setSending(false);
    }
  }
  useEffect(() => {
    if (
      !historyReady ||
      sending || sendBusy.current ||
      !autoSession ||
      autoTriggeredSession.current === autoSession.session_id
    )
      return;
    autoTriggeredSession.current = autoSession.session_id;
    void send(sessionAdvicePrompt(autoSession), { session: autoSession, showUser: false });
  }, [autoSession, historyReady, sending]);
  async function resolvePausedRun(confirmed: boolean) {
    if (!agentRun || agentRun.status !== "paused" || sending) return;
    setSending(true);
    setChatError("");
    try {
      const result = await api.resumeAgentRun(config, agentRun.run_id, confirmed);
      setAgentRun(result.run);
      setMessages((current) => [
        ...current,
        { role: "doctor", text: result.message.content, messageId: result.message.message_id },
      ]);
    } catch (caught) {
      setChatError(friendlyError(caught));
    } finally {
      setSending(false);
    }
  }
  async function rateMessage(messageId: number, rating: "helpful" | "not_helpful") {
    try {
      await api.rateAgentMessage(config, messageId, rating);
      setMessages((current) => current.map((message) =>
        message.messageId === messageId ? { ...message, feedback: rating } : message));
    } catch (caught) {
      setChatError(friendlyError(caught));
    }
  }
  async function updateCurrentFollowup(
    update: Partial<Pick<HealthActionFollowup, "adoption_status" | "perceived_outcome">>,
  ) {
    const followupId = analysisReport?.followup_id;
    if (!followupId || followupBusy.current) return;
    followupBusy.current = true;
    feedbackRevision.current += 1;
    setSavingFollowup(true);
    setFeedbackError("");
    try {
      setFollowup(await api.updateActionFollowup(config, memberId, followupId, update));
    } catch (caught) {
      setFeedbackError(friendlyError(caught));
    } finally {
      followupBusy.current = false;
      setSavingFollowup(false);
    }
  }
  return (
    <section className="page doctor-page">
      <div className="doctor-head">
        <button onClick={onBack}>← 返回</button>
        <div>
          <h1>{autoSession || analysisReport ? "本次分析报告" : "聊聊你的记录"}</h1>
          <p className="report-record-context">{name}{latestSession ? ` · ${new Date(latestSession.occurred_at).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : " · 还没有已认领记录"}</p>
          <details className="assistant-connection"><summary>健康参考 · 自动生成，非医疗诊断</summary><span>
            <i />{" "}
            {agentStatus?.configured
              ? "健康助手在线"
              : agentStatus ? "基础建议可用 · AI 对话未连接" : "正在确认对话服务状态"}
          </span>
          {delegation ? <small className="delegation-status">{sending ? "正在调用" : "本次分析"} {delegation}</small> : null}
          </details>
        </div>
      </div>
      <div className="doctor-layout">
        <aside>
          <img src="/poopsense-mascot-pop-v1.webp" alt="Agent 医生形象" />
          <b>我能帮你</b>
          <p>
            理解本次记录
            <br />
            查看近期趋势
            <br />
            识别需要就医的信号
          </p>
          <small>健康参考，不作为医疗诊断。</small>
        </aside>
        <article className={`chat-panel ${analysisReport ? "has-report" : ""}`}>
          {latestSession ? (
            <section className={`current-result-task ${sending ? "analyzing" : ""}`} aria-labelledby="current-result-title">
              <img className="analysis-waiting-character" src={sessionVisual(latestSession).asset} alt="" />
              <div>
                <small>本次记录</small>
                <b id="current-result-title">
                  {sending && !analysisReport
                    ? "正在生成完整分析报告…"
                    : failedSessionId === latestSession.session_id
                      ? "本次报告暂未完成，请重试"
                    : analysisReport?.session_id === latestSession.session_id
                      ? analysisReport.status === "urgent" ? "安全提醒已生成，请优先查看"
                        : analysisReport.reliable ? "本次分析与行动建议已完成" : "本次信息不足，等待可靠数据"
                      : "新的身体信号已到达"}
                </b>
                <p>{latestSession.message}</p>
                <div className="analysis-live-steps" aria-live="polite">
                  <span className="done">接收信号</span>
                  <span className={analysisReport?.session_id === latestSession.session_id ? "done" : ""}>规则检查</span>
                  <span className={analysisReport?.session_id === latestSession.session_id && analysisReport.reliable ? "done" : ""}>
                    {analysisReport?.session_id === latestSession.session_id && !analysisReport.reliable ? "等待可靠数据" : "行动建议"}
                  </span>
                </div>
              </div>
              {!sending && analysisReport?.session_id !== latestSession.session_id ? (
                <button
                  disabled={!historyReady}
                  onClick={() => void send(
                    sessionAdvicePrompt(latestSession),
                    { session: latestSession, showUser: false },
                  )}
                >
                  {failedSessionId === latestSession.session_id ? "重新生成本次报告" : "立即自动分析 →"}
                </button>
              ) : null}
            </section>
          ) : null}
          {analysisReport ? (
            <AnalysisReport
              report={analysisReport}
              session={latestSession}
              followup={followup?.followup_id === analysisReport.followup_id ? followup : null}
              savingFollowup={savingFollowup}
              feedbackError={feedbackError} onHistory={onHistory}
              onUpdateFollowup={(update) => void updateCurrentFollowup(update)}
            />
          ) : null}
          {agentRun ? (
            <details className="agent-run-trace">
              <summary>查看本次回答依据与 Agent 协作</summary>
              {agentRun.steps.map((step) => (
                <div key={step.step_index}>
                  <b>{step.step_index}. {agentRoleLabel(step.agent_name)}</b>
                  <span>{skillLabel(step.skill_name)} · {step.status}</span>
                  <small>v{step.skill_version}</small>
                </div>
              ))}
              {agentRun.handoffs.map((handoff) => (
                <div className="agent-handoff-line" key={`${handoff.from_agent}:${handoff.to_agent}:${handoff.skill_name}`}>
                  <b>交接：{agentRoleLabel(handoff.from_agent)} → {agentRoleLabel(handoff.to_agent)}</b>
                  <span>仅传递：{handoff.context_domains.map(contextDomainLabel).join("、")}</span>
                  <small>{skillLabel(handoff.skill_name)} · v{handoff.skill_version}</small>
                </div>
              ))}
              <small>最多 {agentRun.max_steps} 步，任务状态已保存。</small>
              {agentRun.status === "paused" ? (
                <div className="agent-run-actions">
                  <button disabled={sending} onClick={() => void resolvePausedRun(true)}>
                    确认继续
                  </button>
                  <button disabled={sending} onClick={() => void resolvePausedRun(false)}>
                    取消任务
                  </button>
                </div>
              ) : null}
            </details>
          ) : null}
          {!latestSession && !analysisReport ? <div className="getting-started"><img src="/poopsense-mascot-pop-v1.webp" alt="" /><div><h2>先有记录，再慢慢了解</h2><p>回首页体验一次模拟检测，或到健康页确认待认领记录。收到结果后，会自动整理观察和建议。</p><button onClick={onBack}>回首页体验 →</button></div></div> : null}
          <div className="quick-prompts">
            <span>对这次结果还有疑问？</span>
            <button disabled={!historyReady || sending} onClick={() => void send("帮我看看最近趋势")}>
              看看最近趋势
            </button>
            <button disabled={!historyReady || sending} onClick={() => void send("最近有点便秘")}>
              便秘怎么办
            </button>
            <button disabled={!historyReady || sending} onClick={() => void send("出现血便怎么办")}>
              需要警惕什么
            </button>
            <button disabled={!historyReady || sending} onClick={() => void send("请让健康医生和生活教练一起做综合分析")}>
              多专家综合分析
            </button>
          </div>
          {!historyReady ? <p role="status">正在接回此前对话，你可以先输入，加载完成后再发送。</p> : null}
          {detailWarning && <p role="status">{detailWarning}</p>}
          {chatError && (
            <p className="chat-error" role="alert">
              {chatError}
            </p>
          )}
          {[true, false].map((historical) => {
            const group = messages.filter((message) => Boolean(message.historical) === historical);
            if (!group.length) return null;
            const content = group.map((message, index) => (
              <div key={index} className={`message ${message.role}`}>
                <b>{message.role === "doctor" ? "Agent 医生" : name}</b>
                <p>{message.text}</p>
                {message.role === "doctor" && message.messageId ? (
                  <div className="message-feedback" aria-label="评价这条建议">
                    <button aria-pressed={message.feedback === "helpful"} onClick={() => void rateMessage(message.messageId!, "helpful")}>有帮助</button>
                    <button aria-pressed={message.feedback === "not_helpful"} onClick={() => void rateMessage(message.messageId!, "not_helpful")}>没帮助</button>
                  </div>
                ) : null}
              </div>
            ));
            return historical ? (
              <details className="conversation-history" key="history">
                <summary>查看此前对话（{group.length} 条）</summary>
                <p>以下是此前保存的对话，不代表本次检测结果；旧称谓也不表示真人医生审核。</p>
                <div className="messages">{content}</div>
              </details>
            ) : <div key="current" className="messages" aria-live="polite">{content}</div>;
          })}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor="doctor-message">
              描述你的情况
            </label>
            <textarea
              id="doctor-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="例如：最近两天有点偏硬，需要注意什么？"
            />
            <button disabled={!historyReady || !draft.trim() || sending}>
              {!historyReady ? "正在加载对话…" : sending ? "思考中…" : "发送 →"}
            </button>
          </form>
        </article>
      </div>
    </section>
  );
}
function Health({
  config,
  inbox,
  members,
  selected,
  onSelect,
  trend,
  trendDays,
  onTrendDaysChange,
  sessions,
  busy,
  onAssign,
  onOpenReport,
  section, onSection, requestedSource, onSourceChange, active, recordsLoading, recordsError, trendError, onRetry,
}: {
  config: AppConfig;
  inbox: InboxItem[];
  members: Member[];
  selected: string;
  onSelect: (v: string) => void;
  trend: Trend | null;
  trendDays: number;
  onTrendDaysChange: (days: number) => void;
  sessions: MemberSession[];
  busy: boolean;
  onAssign: (s: string, m: string, c?: boolean) => void;
  onOpenReport: (session: MemberSession) => void;
  section: HealthSection; onSection: (section: HealthSection) => void; requestedSource: string; onSourceChange: (source: string) => void; active: boolean;
  recordsLoading: boolean; recordsError: string; trendError: string; onRetry: () => void;
}) {
  const currentMember = members.find(member => member.member_id === selected);
  return (
    <section className={`page health-page health-${section}`}>
      <header className="health-intro health-chapter">
        <div><small>RECORD BOOK</small><h1>{currentMember ? `${memberName(currentMember)} 的记录册` : "我的记录册"}</h1><p>从一条观察，到下一次回看。</p></div>
        <div className="chapter-character"><img src={sessionVisual(sessions[0]).asset} alt="最近一次记录的形象" /><span>一页一页，慢慢了解</span></div>
      </header>
      <div className="health-controls">
      <div className="member-filter">
        <select aria-label="查看哪位成员" value={selected} onChange={(e) => onSelect(e.target.value)}>
          {members.map((member) => (
            <option key={member.member_id} value={member.member_id}>
              {memberName(member)}
            </option>
          ))}
        </select>
        <div className="period-switch" aria-label="长期变化时间范围" hidden={section !== "trends"}>
          {[30, 90].map((days) => (
            <button
              type="button"
              key={days}
              aria-pressed={trendDays === days}
              onClick={() => onTrendDaysChange(days)}
            >
              {days} 天
            </button>
          ))}
        </div>
      </div>
      <nav className="health-sections" aria-label="记录册内容">
        {([{ id: "records", label: "记录" }, { id: "actions", label: "行动" }, { id: "trends", label: "趋势" }] as const).map(item => <button key={item.id} aria-pressed={section === item.id} onClick={() => onSection(item.id)}>{item.label}{item.id === "records" && inbox.length ? <small>{inbox.length} 待确认</small> : null}</button>)}
      </nav>
      </div>
      <div hidden={section !== "actions"}>
      <ActionFollowupPanel config={config} memberId={selected} sessions={sessions} onOpenReport={onOpenReport} requestedSource={requestedSource} onSourceChange={onSourceChange} onShowRecords={() => onSection("records")}
        refreshKey={`${active}:${sessions.map(item => `${item.session_id}:${item.assignment_version}:${item.assessment_status}:${item.risk_level}`).join("|")}`} />
      </div>
      <div hidden={section !== "records"}>
      {!!inbox.length && <InboxPanel
        inbox={inbox}
        members={members}
        busy={busy}
        onAssign={onAssign}
      />}
      <section className="progressive-panel record-details" aria-label="最近记录">
        <header className="records-title"><b>最近记录</b><span>{recordsLoading ? "正在读取…" : recordsError && !sessions.length ? "暂未读到" : `${sessions.length} 次已归属记录`}</span></header>
        <article className="history">
        {recordsError && <div className="record-load-error" role="alert"><span>{sessions.length ? "新记录暂时未更新，当前显示上次读取的内容。" : "暂时无法读取记录。"}{recordsError}</span><button onClick={onRetry}>重试读取记录</button></div>}
        {!sessions.length && !recordsError && <p className="muted" role="status">{recordsLoading ? "正在读取这个成员的记录…" : "还没有已认领记录。"}</p>}
        {sessions.slice(0, 2).map((item) => (
          <div className="history-row" key={item.session_id}>
            <span className={`record-avatar ${item.risk_level}`}><img src={sessionVisual(item).asset} alt={sessionVisual(item).label} /></span>
            <span>
              <b>{new Date(item.occurred_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</b>
              <small>{item.message}</small>
              <button className="history-report-link" onClick={() => onOpenReport(item)}>查看这条报告 →</button>
            </span>
            <Correction
              session={item}
              members={members}
              current={selected}
              onCorrect={onAssign}
            />
          </div>
        ))}
        {sessions.length > 2 && (
          <details className="history-more">
            <summary>查看更早的 {sessions.length - 2} 条记录</summary>
            {sessions.slice(2).map((item) => (
              <div className="history-row" key={item.session_id}>
                <span className={`record-avatar ${item.risk_level}`}><img src={sessionVisual(item).asset} alt={sessionVisual(item).label} /></span>
                <span>
                  <b>
                    {new Date(item.occurred_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </b>
                  <small>{item.message}</small>
                  <button className="history-report-link" onClick={() => onOpenReport(item)}>查看这条报告 →</button>
                </span>
                <Correction
                  session={item}
                  members={members}
                  current={selected}
                  onCorrect={onAssign}
                />
              </div>
            ))}
          </details>
        )}
        </article>
      </section>
      </div>
      <div hidden={section !== "trends"}>
      {trendError && <div className="record-load-error" role="alert"><span>趋势暂时未更新。{trendError}</span><button onClick={onRetry}>重试读取趋势</button></div>}
      {trend ? <LongitudinalOverview trend={trend} /> : !trendError && <p role="status">正在整理这个成员的趋势…</p>}
      {trend?.insufficient_coverage && (
        <div className="coverage-note">
          <b>样本覆盖还不够</b>
          <span>
            有效覆盖 {Math.round(trend.valid_sample_coverage * 100)}
            %，暂不做趋势判断，只展示事实。
          </span>
        </div>
      )}
      <div className="metrics">
        <Metric
          label="每周频率"
          value={`${trend?.frequency_per_week ?? "—"}`}
          unit=" 次"
        />
        <Metric
          label="连续异常"
          value={`${trend?.consecutive_abnormal ?? "—"}`}
          unit=" 次"
        />
      </div>
      <TrendMap trend={trend} />
      <details className="progressive-panel">
        <summary><b>本周健康周报</b><span>把可靠记录整理成一页结论</span></summary>
        <WeeklyReportPanel config={config} memberId={selected} />
      </details>
      <details className="progressive-panel">
        <summary><b>让 Agent 更懂你</b><span>健康档案与可修改记忆</span></summary>
        <HealthProfilePanel config={config} memberId={selected} />
        <MemoryPanel config={config} memberId={selected} />
      </details>
      </div>

    </section>
  );
}

function LongitudinalOverview({ trend }: { trend: Trend }) {
  const progress = Math.min(
    100,
    Math.round(
      trend.baseline_progress.current_valid_sessions
      / trend.baseline_progress.required_valid_sessions * 100,
    ),
  );
  const changeLabels: Record<Trend["latest_change"]["status"], string> = {
    insufficient: "等待下一次可靠记录",
    improved: "正在回到日常范围",
    stable: "最近保持稳定",
    worsened: "最近出现了偏离",
    changed: "最近有新的变化",
  };
  return (
    <section className="longitudinal-overview" aria-label="个人长期变化摘要">
      <article className="baseline-card">
        <small>我的正常是什么</small>
        <b>{trend.baseline_progress.status === "established" ? "个人日常已建立" : "正在认识你的日常"}</b>
        <p>{trend.baseline_progress.message}</p>
        <div className="baseline-progress" aria-label={`基线积累 ${progress}%`}>
          <i style={{ width: `${progress}%` }} />
        </div>
        <span>{trend.baseline_progress.status === "established"
          ? `已用 ${trend.baseline_progress.current_valid_sessions} 次可靠记录持续更新`
          : `${trend.baseline_progress.current_valid_sessions} / ${trend.baseline_progress.required_valid_sessions} 次可靠记录`}</span>
      </article>
      <article className={`change-card ${trend.latest_change.status}`}>
        <small>最近发生了什么</small>
        <b>{changeLabels[trend.latest_change.status]}</b>
        <p>{trend.latest_change.message}</p>
      </article>
    </section>
  );
}

function ActionFollowupPanel({ config, memberId, refreshKey, sessions, onOpenReport, requestedSource, onSourceChange, onShowRecords }: { config: AppConfig; memberId: string; refreshKey: string; sessions: MemberSession[]; onOpenReport: (session: MemberSession) => void; requestedSource: string; onSourceChange: (source: string) => void; onShowRecords: () => void }) {
  const [items, setItems] = useState<HealthActionFollowup[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const savingRef = useRef(false);
  const mutationRevision = useRef(0);
  useEffect(() => {
    if (savingRef.current) return;
    let active = true;
    const revision = mutationRevision.current;
    setLoadError("");
    setLoading(true);
    api.actionFollowups(config, memberId)
      .then((result) => { if (active && revision === mutationRevision.current && !savingRef.current) setItems(result); })
      .finally(() => { if (active) setLoading(false); })
      .catch((caught) => { if (active && revision === mutationRevision.current) setLoadError(friendlyError(caught)); });
    return () => { active = false; };
  }, [config, memberId, refreshKey, refreshVersion]);
  async function update(
    item: HealthActionFollowup,
    change: Partial<Pick<HealthActionFollowup, "adoption_status" | "perceived_outcome">>,
  ) {
    if (savingRef.current) return;
    savingRef.current = true;
    mutationRevision.current += 1;
    setSaving(true);
    setError("");
    try {
      const saved = await api.updateActionFollowup(config, memberId, item.followup_id, change);
      setItems((current) => current.map((candidate) =>
        candidate.followup_id === saved.followup_id ? saved : candidate));
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      savingRef.current = false;
      setSaving(false);
      setRefreshVersion(version => version + 1);
    }
  }
  const latest = requestedSource ? items.find(item => item.source_session_id === requestedSource)
    : items.find(item => item.adoption_status === "accepted" || item.adoption_status === "completed") ?? items[0];
  if (!latest && !error && !loadError) return <div className="action-empty"><img src="/poopsense-mascot-pop-v1.webp" alt="" /><h2>{loading ? "正在找回你的回应…" : requestedSource ? "暂时没读到这条记录的行动" : "这里会接着记下你的选择"}</h2><p>{loading ? "稍等片刻。" : requestedSource ? "可以重新读取，或回到记录册查看原报告。" : "打开一条记录，选好想尝试的建议，再回来看看后续变化。"}</p>{!loading && <>{requestedSource && <button onClick={() => setRefreshVersion(version => version + 1)}>重新读取</button>}<button onClick={onShowRecords}>去看记录 →</button></>}</div>;
  const source = sessions.find(item => item.session_id === latest?.source_session_id);
  const comparison = sessions.find(item => item.session_id === latest?.observed_from_session_id);
  const recommendationDirections = latest?.recommendation_categories?.map(category => ({ hydration: "补水", diet: "饮食", movement: "日常活动", observation: "观察", care: "寻求专业帮助" }[category] ?? "生活建议")).join("、");
  const observedLabel = {
    pending: "等下一次可靠记录自动回看",
    improved: "后续记录回到常见范围",
    same: "后续记录与这次相近",
    worse: "后续记录出现更多偏离",
    changed: "后续记录发生了不同变化",
    insufficient: "后续信息不足，暂不比较",
  }[latest?.observed_outcome ?? "pending"];
  return (
    <article className="action-followup-panel" aria-label="行动回看">
      <h2 className="sr-only">行动回看</h2>
      {loadError && <div role="alert"><p>跟进结果暂时未更新：{loadError}</p>
        <button disabled={saving} onClick={() => setRefreshVersion(version => version + 1)}>重试加载跟进</button>
      </div>}
      {latest && items.length > 1 && (
        <label>查看哪次建议
          <select aria-label="查看哪次建议" value={latest.followup_id} disabled={saving}
            style={{ maxWidth: "100%" }} onChange={event => onSourceChange(items.find(item => item.followup_id === event.target.value)?.source_session_id ?? "")}>
            {items.map((item, index) => (
              <option key={item.followup_id} value={item.followup_id}>
                {sessions.find(record => record.session_id === item.source_session_id) ? new Date(sessions.find(record => record.session_id === item.source_session_id)!.occurred_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : `来源记录 ${index + 1}（未载入）`} · {item.adoption_status === "suggested" ? "未选择" : item.adoption_status === "skipped" ? "未采用" : "已回应"}
              </option>
            ))}
          </select>
        </label>
      )}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {latest && <div className="followup-observation">
        <img src={comparison ? sessionVisual(comparison).asset : "/poopsense-mascot-pop-v1.webp"} alt={comparison ? "后续记录的形象" : ""} />
        <div><small>后续观察</small><h3>{observedLabel}</h3>{comparison ? <time>{new Date(comparison.occurred_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time> : <p>有可比较的记录后，这里会接着更新。</p>}</div>
      </div>}
      {latest ? (
        <div className="action-followup-body">
          <fieldset className="action-followup-actions" disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {saving && <span role="status">正在保存…</span>}
            {latest.adoption_status === "suggested" ? (
              <>
                <button onClick={() => void update(latest, { adoption_status: "accepted" })}>我会试试</button>
                <button onClick={() => void update(latest, { adoption_status: "skipped" })}>这次不采用</button>
              </>
            ) : (
              <span className="followup-plan-state"><span>{latest.adoption_status === "skipped" ? "未采用" : latest.adoption_status === "completed" ? "已记录感受" : "已保存意向"}</span>{recommendationDirections && <span className="followup-directions">原报告建议：{recommendationDirections}</span>}</span>
            )}
            {latest.observed_outcome !== "pending" ? (
              <div aria-label="我的感受">
                <small>和{source ? new Date(source.occurred_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "这次"}记录时相比，现在感觉怎样？</small>
                <button aria-pressed={latest.perceived_outcome === "improved"} onClick={() => void update(latest, { perceived_outcome: "improved", adoption_status: "completed" })}>有改善</button>
                <button aria-pressed={latest.perceived_outcome === "same"} onClick={() => void update(latest, { perceived_outcome: "same", adoption_status: "completed" })}>差不多</button>
                <button aria-pressed={latest.perceived_outcome === "worse"} onClick={() => void update(latest, { perceived_outcome: "worse", adoption_status: "completed" })}>更不舒服</button>
              </div>
            ) : null}
          </fieldset>
          {latest.perceived_outcome && latest.perceived_outcome !== "pending" && <p className="followup-saved-reply" role="status">已记下：{({ improved: "有改善", same: "差不多", worse: "更不舒服" } as const)[latest.perceived_outcome]}。这是你的感受，传感观察会单独保留。</p>}
          <p className="followup-boundary">感受与传感观察分开记录，前后变化不代表建议产生了效果。</p>
          <div className="followup-source">
            <div><small>这次回看的起点</small><b>{source ? new Date(source.occurred_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "来源记录未载入"}</b><span>{latest.adoption_status === "suggested" ? "还未选择" : latest.adoption_status === "skipped" ? "暂不采用" : latest.adoption_status === "completed" ? "已补充感受" : "准备试试"}{latest.recommendation_categories?.length ? ` · ${latest.recommendation_categories.map(category => ({ hydration: "补水", diet: "饮食", movement: "日常活动", observation: "观察", care: "寻求专业帮助" }[category] ?? category)).join("、")}` : ""}</span></div>
            {source && <button className="timeline-report-link" onClick={() => onOpenReport(source)}>重看这条报告 →</button>}
          </div>
          <details className="followup-context">
            <summary>查看原记录与对照依据</summary>
            <ol className="action-timeline" aria-label="从记录到回看的时间线">
              <li><small>上次记录</small><b>{source?.message ?? "建议来源记录"}</b><time>{source ? new Date(source.occurred_at).toLocaleString("zh-CN") : "当前列表未载入这条原记录"}</time></li>
              <li><small>后续记录</small><b>{comparison?.message ?? observedLabel}</b>{comparison && <time>{new Date(comparison.occurred_at).toLocaleString("zh-CN")}</time>}</li>
            </ol>
            <p>{latest.observed_outcome_note ?? "只比较同一成员的可靠记录；选择不代表已经执行或产生效果。"}</p>
          </details>
        </div>
      ) : null}
    </article>
  );
}

function WeeklyReportPanel({ config, memberId }: { config: AppConfig; memberId: string }) {
  const [reports, setReports] = useState<WeeklyHealthReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    api.weeklyReports(config, memberId)
      .then((result) => { if (active) setReports(result); })
      .catch((caught) => { if (active) setError(friendlyError(caught)); });
    return () => { active = false; };
  }, [config, memberId]);

  async function generateReport() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const report = await api.generateWeeklyReport(config, memberId);
      setReports((current) => [report, ...current.filter((item) => item.report_id !== report.report_id)]);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  const latest = reports[0];
  return (
    <article className="weekly-report-panel" aria-label="健康周报">
      <div className="weekly-report-head">
        <div className="card-title"><span>WEEKLY</span><h2>健康周报</h2></div>
        <button type="button" onClick={generateReport} disabled={busy}>
          {busy ? "生成中…" : latest ? "刷新本周周报" : "生成本周周报"}
        </button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!latest ? <p className="muted">还没有周报。生成后会把可靠事实、建议与 Agent 解释保存在一起。</p> : (
        <div className="weekly-report-body">
          <div>
            <small>{latest.period_start} — {latest.period_end}</small>
            <strong>{latest.status === "ready" ? "本周洞察" : "样本积累中"}</strong>
            <p>{latest.summary}</p>
          </div>
          <div className="weekly-facts" aria-label="周报事实">
            <span><b>{latest.facts.valid_sessions}</b>可靠记录</span>
            <span><b>{Math.round(latest.facts.coverage * 100)}%</b>有效覆盖</span>
            <span><b>{latest.facts.consecutive_abnormal}</b>连续异常</span>
          </div>
          <ul>{latest.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>
          <small>依据 {latest.policy_version} · {latest.model_version}</small>
        </div>
      )}
    </article>
  );
}

const EMPTY_HEALTH_PROFILE: HealthProfile = {
  member_id: "", conditions: [], diet_pattern: "", sleep_pattern: "",
  medications: [], goals: [], completeness: 0, updated_at: null,
};

function splitList(value: string) {
  return value.split(/[，,、]/).map((item) => item.trim()).filter(Boolean);
}

function HealthProfilePanel({ config, memberId }: { config: AppConfig; memberId: string }) {
  const [profile, setProfile] = useState<HealthProfile>(EMPTY_HEALTH_PROFILE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.healthProfile(config, memberId)
      .then((result) => { if (active) setProfile(result); })
      .catch((caught) => { if (active) setError(friendlyError(caught)); });
    return () => { active = false; };
  }, [config, memberId]);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setProfile(await api.updateHealthProfile(config, memberId, profile));
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="health-profile-panel">
      <div className="card-title"><span>PROFILE</span><h2>让 Agent 更懂你</h2></div>
      <p className="muted">自报档案完成 {Math.round(profile.completeness * 100)}% · 每次修改都会保留版本。</p>
      <div className="health-profile-grid">
        <label>已有状况<input value={profile.conditions.join("、")} onChange={(event) => setProfile({ ...profile, conditions: splitList(event.target.value) })} placeholder="例如：肠易激、无" /></label>
        <label>饮食习惯<input value={profile.diet_pattern} onChange={(event) => setProfile({ ...profile, diet_pattern: event.target.value })} placeholder="例如：常吃辣，蔬菜较少" /></label>
        <label>作息情况<input value={profile.sleep_pattern} onChange={(event) => setProfile({ ...profile, sleep_pattern: event.target.value })} placeholder="例如：00:30 入睡" /></label>
        <label>正在使用的药物<input value={profile.medications.join("、")} onChange={(event) => setProfile({ ...profile, medications: splitList(event.target.value) })} placeholder="没有可留空" /></label>
        <label>健康目标<input value={profile.goals.join("、")} onChange={(event) => setProfile({ ...profile, goals: splitList(event.target.value) })} placeholder="例如：规律排便、多喝水" /></label>
      </div>
      <button disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存健康档案"}</button>
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
    </article>
  );
}

function MemoryPanel({
  config,
  memberId,
}: {
  config: AppConfig;
  memberId: string;
}) {
  const [memory, setMemory] = useState<AgentMemory[]>([]);
  const [keyDraft, setKeyDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!memberId) return;
    setMemory(await api.memory(config, memberId));
  }, [config, memberId]);
  useEffect(() => {
    void refresh().catch((caught) => setError(friendlyError(caught)));
  }, [refresh]);
  async function add() {
    if (!keyDraft.trim() || !contentDraft.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.addMemory(
        config,
        memberId,
        keyDraft.trim(),
        contentDraft.trim(),
      );
      setKeyDraft("");
      setContentDraft("");
      await refresh();
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }
  async function save(item: AgentMemory) {
    if (!editDraft.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.updateMemory(
        config,
        memberId,
        item.logical_id,
        editDraft.trim(),
        item.source_type === "system_inference"
          ? "用户纠正系统推断"
          : undefined,
      );
      setEditing(undefined);
      await refresh();
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="memory-panel">
      <div className="card-title">
        <span>MEMORY</span>
        <h2>Agent 记忆</h2>
      </div>
      <p className="muted">
        自报信息可修改，系统推断可纠正，传感事实不可覆盖。
      </p>
      <div className="memory-list">
        {memory.map((item) => (
          <div className="memory-row" key={item.logical_id}>
            <span className={`memory-source ${item.source_type}`}>
              {memorySourceLabel(item.source_type)}
            </span>
            <div>
              <b>{item.memory_key}</b>
              {editing === item.logical_id ? (
                <textarea
                  value={editDraft}
                  onChange={(event) => setEditDraft(event.target.value)}
                />
              ) : (
                <p>{item.content}</p>
              )}
              <small>
                v{item.version} ·{" "}
                {new Date(item.created_at).toLocaleDateString("zh-CN")}
              </small>
            </div>
            {item.editable ? (
              editing === item.logical_id ? (
                <button onClick={() => void save(item)} disabled={busy}>
                  保存
                </button>
              ) : (
                <button
                  onClick={() => {
                    setEditing(item.logical_id);
                    setEditDraft(item.content);
                  }}
                >
                  修改
                </button>
              )
            ) : (
              <em>事实锁定</em>
            )}
          </div>
        ))}
        {!memory.length && (
          <p className="muted">还没有记忆，可以先告诉 Agent 一件重要的事。</p>
        )}
      </div>
      <div className="memory-add">
        <input
          aria-label="记忆名称"
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder="例如：饮食偏好"
        />
        <input
          aria-label="记忆内容"
          value={contentDraft}
          onChange={(event) => setContentDraft(event.target.value)}
          placeholder="例如：平时很少吃辣"
        />
        <button
          onClick={() => void add()}
          disabled={busy || !keyDraft.trim() || !contentDraft.trim()}
        >
          ＋ 添加自报
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
function memorySourceLabel(value: AgentMemory["source_type"]) {
  return {
    self_report: "用户自报",
    sensor_fact: "传感事实",
    system_inference: "系统推断",
  }[value];
}
function InboxPanel({
  inbox,
  members,
  busy,
  onAssign,
}: {
  inbox: InboxItem[];
  members: Member[];
  busy: boolean;
  onAssign: (s: string, m: string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  return (
    <article className="inbox-panel">
      <div>
        <span className="inbox-count">{inbox.length}</span>
        <div>
          <p className="kicker">家庭待认领箱</p>
          <h2>
            {inbox.length
              ? `有 ${inbox.length} 次记录等你确认`
              : "今天的记录都归位了"}
          </h2>
          <p>认领前不会进入个人趋势，也不会生成定向提醒。</p>
        </div>
      </div>
      {inbox.map((item) => (
        <div className="claim-row" key={item.session_id}>
          <span>
            {new Date(item.received_at).toLocaleString("zh-CN", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <select
            aria-label="这是谁的记录？"
            value={choices[item.session_id] ?? ""}
            onChange={(e) =>
              setChoices({ ...choices, [item.session_id]: e.target.value })
            }
          >
            <option value="">这是谁的记录？</option>
            {members.map((member) => (
              <option key={member.member_id} value={member.member_id}>
                {memberName(member)}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !choices[item.session_id]}
            onClick={() => onAssign(item.session_id, choices[item.session_id])}
          >
            确认归属
          </button>
        </div>
      ))}
    </article>
  );
}
const PET_SKINS: { id: PetSnapshot["selected_skin"]; label: string }[] = [
  { id: "classic", label: "经典奶油" },
  { id: "blue_wave", label: "蓝色波浪" },
  { id: "pop_star", label: "波普明星" },
];

function Social({ config, memberId, active }: { config: AppConfig; memberId: string; active: boolean }) {
  const socialRef = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [pet, setPet] = useState<PetSnapshot | null>(null);
  const [petName, setPetName] = useState("");
  const serverPetName = useRef("");
  const refreshVersion = useRef(0);
  const writing = useRef(false);
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [topic, setTopic] = useState<CommunityPost["topic"]>("hydration");
  const [postContent, setPostContent] = useState("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [mapZoom, setMapZoom] = useState(1);
  const [selectedAgentId, setSelectedAgentId] = useState("mine");
  const [activePlace, setActivePlace] = useState("中央广场");
  const setBusy = useCallback((value: boolean) => {
    writing.current = value;
    if (value) refreshVersion.current += 1;
    setBusyState(value);
  }, []);
  const applyPetSnapshot = useCallback((next: PetSnapshot, previousName = serverPetName.current) => {
    serverPetName.current = next.name;
    setPet(next);
    setPetName(current => current === previousName ? next.name : current);
  }, []);
  useEffect(() => {
    if (!active || !memberId || busy) return;
    let current = true;
    const version = ++refreshVersion.current;
    Promise.allSettled([api.pet(config, memberId), api.communityPosts(config), api.agentConnections(config, memberId)])
      .then(([petResult, postResults, connectionResults]) => {
        if (!current || writing.current || version !== refreshVersion.current) return;
        if (petResult.status === "fulfilled") applyPetSnapshot(petResult.value);
        if (postResults.status === "fulfilled") setPosts(postResults.value);
        if (connectionResults.status === "fulfilled") setConnections(connectionResults.value);
        const failed = [petResult, postResults, connectionResults].find((result) => result.status === "rejected");
        setRefreshError(failed?.status === "rejected" ? `部分岛上信息未能更新，可能仍显示上次状态。${friendlyError(failed.reason)}` : "");
      });
    return () => { current = false; };
  }, [active, busy, config, memberId, applyPetSnapshot]);
  async function checkIn() {
    if (!memberId || writing.current) return;
    setBusy(true);
    try {
      const result = await api.checkInPet(config, memberId);
      applyPetSnapshot(result.pet);
      setNotice(result.duplicate ? "今天已经打过卡啦。" : "打卡成功，宠物成长值已记录。");
    } catch (caught) {
      setNotice(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }
  async function savePet(selectedSkin = pet?.selected_skin) {
    if (!memberId || !pet || !selectedSkin || !petName.trim() || writing.current) return;
    setBusy(true);
    try {
      const updated = await api.updatePet(config, memberId, petName.trim(), selectedSkin);
      applyPetSnapshot(updated, petName);
      setNotice("宠物档案已保存。");
    } catch (caught) {
      setNotice(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }
  async function publishPost() {
    if (!memberId || !consented || postContent.trim().length < 2 || writing.current) return;
    setBusy(true);
    try {
      const created = await api.publishCommunityPost(config, memberId, topic, postContent.trim());
      setPosts((current) => [created, ...current]);
      setPostContent(""); setConsented(false); setComposeOpen(false);
      setNotice("已由你的 Agent 发布，可随时撤回。");
    } catch (caught) { setNotice(friendlyError(caught)); }
    finally { setBusy(false); }
  }
  async function withdrawPost(postId: string) {
    if (writing.current) return;
    setBusy(true);
    try {
      await api.withdrawCommunityPost(config, postId);
      setPosts((current) => current.filter((post) => post.post_id !== postId));
      setNotice("内容已撤回，社区不再展示。");
    } catch (caught) { setNotice(friendlyError(caught)); }
    finally { setBusy(false); }
  }
  async function requestConnection(postId: string) {
    if (writing.current) return; setBusy(true);
    try { const item = await api.requestAgentConnection(config, memberId, postId); setConnections((current) => [item, ...current]); setNotice("邀请已发送，等待对方明确同意。"); }
    catch (caught) { setNotice(friendlyError(caught)); } finally { setBusy(false); }
  }
  async function respondConnection(connectionId: string, accept: boolean) {
    if (writing.current) return; setBusy(true);
    try { const item = await api.respondAgentConnection(config, memberId, connectionId, accept); setConnections((current) => current.map((entry) => entry.connection_id === item.connection_id ? item : entry)); }
    catch (caught) { setNotice(friendlyError(caught)); } finally { setBusy(false); }
  }
  async function endConnection(connectionId: string) {
    if (writing.current) return; setBusy(true);
    try { const item = await api.endAgentConnection(config, memberId, connectionId); setConnections((current) => current.map((entry) => entry.connection_id === item.connection_id ? item : entry)); }
    catch (caught) { setNotice(friendlyError(caught)); } finally { setBusy(false); }
  }
  const connectedAliases = connections
    .filter((item) => item.status === "connected")
    .map((item) => item.other_agent_alias);
  const discoverablePosts = posts.filter((post) => !post.can_withdraw);
  const friendAliases = Array.from(new Set([
    ...connectedAliases,
    ...discoverablePosts.map((post) => post.agent_alias),
  ])).slice(0, 3);
  const islandAgents = [
    {
      id: "mine", alias: pet ? `${pet.name}的 Agent` : "我的 Agent",
      status: "我的岛上形象", place: "plaza", mine: true, postId: "",
    },
    ...friendAliases.map((alias, index) => ({
      id: `friend-${index}`, alias,
      status: connectedAliases.includes(alias) ? "已建立连接 · 岛上形象" : "来自公开动态 · 岛上形象",
      place: ["lawn", "coffee", "pier"][index] ?? "plaza",
      mine: false,
      postId: discoverablePosts.find((post) => post.agent_alias === alias)?.post_id ?? "",
    })),
  ];
  const selectedAgent = islandAgents.find((agent) => agent.id === selectedAgentId) ?? islandAgents[0];
  function visitPlace(place: "lawn" | "coffee" | "plaza" | "pier" | "home") {
    const labels = { lawn: "晒太阳草坪", coffee: "咖啡小屋", plaza: "中央广场", pier: "朋友码头", home: "我的小屋" };
    setActivePlace(labels[place]);
    if (place === "coffee") { setNotice(""); setTopic("diet"); setComposeOpen(true); }
    if (place === "plaza") { setNotice(""); setTopic("encouragement"); setComposeOpen(true); }
    if (place === "lawn") setNotice("来到晒太阳草坪。今天打卡后，可以留下这次到访的记录。");
    if (place === "pier") setNotice("朋友码头会展示双方明确同意后的 Agent 连接。");
    if (place === "home") setSelectedAgentId("mine");
    if (place === "home" || place === "pier") {
      const panel = socialRef.current?.querySelector<HTMLDetailsElement>(place === "home" ? ".island-pet-settings" : ".island-relations-toggle");
      if (panel) { panel.open = true; panel.scrollIntoView?.({ block: "start", behavior: "instant" }); panel.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true }); }
    }
  }
  async function greetSelectedAgent() {
    if (selectedAgent.mine) {
      setNotice("这就是你的 Agent。去中央广场可以让它发布一条问候。");
      return;
    }
    if (selectedAgent.postId) {
      await requestConnection(selectedAgent.postId);
      return;
    }
    setNotice(connectedAliases.includes(selectedAgent.alias) ? "你们已经建立连接，可以在朋友码头查看。" : "暂时没有可用于认识邀请的公开动态。");
  }
  return (
    <section className="page social-page island-page" ref={socialRef}>
      <header className="island-header">
        <div>
          <p className="island-kicker">POOP ISLAND</p>
          <h1>便便岛</h1>
          <p>带着你的伙伴逛一逛，只聊愿意公开的小事。</p>
        </div>
        <div className="island-header-actions">
          <span className="island-weather">岛屿为互动场景，不代表真实在线位置</span>
          <button onClick={() => { setNotice(""); setComposeOpen((open) => !open); }}>
            {composeOpen ? "收起发布框" : "让 Agent 发一条 →"}
          </button>
        </div>
      </header>

      {refreshError && <p className="chat-error" role="alert">{refreshError}</p>}
      <div className="island-layout">
        <main className="island-map-shell" aria-label="便便岛互动地图">
          <div className="island-map-toolbar">
            <span><i /> 你在：{activePlace}</span>
            <button onClick={() => setSelectedAgentId("mine")}>回到我的 Agent</button>
          </div>
          <div className="island-canvas">
            <div className="island-map-world" style={{ transform: `scale(${mapZoom})` }}>
              <img className="island-map-image" src="/poop-island-map-v1.webp" loading="lazy" decoding="async" alt="便便岛：草坪、咖啡小屋、中央广场、朋友码头和我的小屋" />
              <button className="island-place place-lawn" onClick={() => visitPlace("lawn")}><span>晒太阳草坪</span></button>
              <button className="island-place place-coffee" onClick={() => visitPlace("coffee")}><span>咖啡小屋</span></button>
              <button className="island-place place-plaza" onClick={() => visitPlace("plaza")}><span>中央广场</span></button>
              <button className="island-place place-pier" onClick={() => visitPlace("pier")}><span>朋友码头</span></button>
              <button className="island-place place-home" onClick={() => visitPlace("home")}><span>我的小屋</span></button>
              {islandAgents.map((agent) => (
                <button
                  key={agent.id}
                  className={`island-agent agent-${agent.place} ${agent.mine ? "is-mine" : ""} ${selectedAgent.id === agent.id ? "is-selected" : ""}`}
                  onClick={() => setSelectedAgentId(agent.id)}
                  aria-label={`查看${agent.alias}`}
                >
                  <span className="agent-speech">{agent.mine ? "我在这里" : "···"}</span>
                  <img src="/poop-island-agent-v1.webp" alt="" />
                  <small>{agent.alias}</small>
                </button>
              ))}
            </div>
            <div className="island-zoom" aria-label="地图缩放">
              <button aria-label="放大地图" disabled={mapZoom >= 1.15} onClick={() => setMapZoom((zoom) => Math.min(1.15, zoom + 0.15))}>＋</button>
              <button aria-label="缩小地图" disabled={mapZoom <= 0.85} onClick={() => setMapZoom((zoom) => Math.max(0.85, zoom - 0.15))}>−</button>
            </div>
          </div>

          <article className="island-focus-card" aria-label="便便宠物和皮肤图鉴">
            <img src="/poop-island-agent-v1.webp" alt="当前选中的 Agent" />
            <div>
              <small>{selectedAgent.mine ? "我的伙伴" : "岛上遇见"}</small>
              <h2>{selectedAgent.alias}</h2>
              <p><i /> {selectedAgent.status}</p>
              {selectedAgent.mine && pet ? (
                <>
                  <span>{petMoodLabel(pet.mood)} · {petStageLabel(pet.stage)} · 连续 {pet.streak_days} 天</span>
                  <em>{pet.health_basis === "insufficient" ? "可靠样本不足，宠物保持探索状态" : "状态来自已放行的可靠健康摘要"}</em>
                </>
              ) : <span>只会看到对方主人主动公开的岛上状态</span>}
            </div>
            {selectedAgent.mine && pet ? (
              <button disabled={busy || pet.checked_in_today} onClick={() => void checkIn()}>
                {pet.checked_in_today ? "今天已打卡" : "今天打卡"}
              </button>
            ) : <button disabled={busy} onClick={() => void greetSelectedAgent()}>去打招呼</button>}
          </article>
        </main>

        <details className="island-relations-toggle"><summary>岛上关系 · {connectedAliases.length} 个已连接</summary>
        <aside className="island-relations" aria-label="岛上关系">
          <header><h2>岛上关系</h2><span>{connections.filter((item) => item.status === "connected").length} 个已连接</span></header>
          <section>
            <h3>我的 Agent</h3>
            <button
              className="relation-agent is-owner"
              aria-label={`${islandAgents[0].alias} · 代表当前成员`}
              onClick={() => setSelectedAgentId("mine")}
            >
              <img src="/poop-island-agent-v1.webp" alt="" />
              <span><b>{islandAgents[0].alias}</b><small><i /> 代表当前成员</small></span>
            </button>
          </section>
          <section>
            <h3>岛上伙伴 {friendAliases.length}</h3>
            {!friendAliases.length && <p>有公开动态或双方连接后，伙伴会出现在这里。</p>}
            {islandAgents.filter((agent) => !agent.mine).map((agent) => (
              <button
                key={agent.id}
                className="relation-agent"
                aria-label={`${agent.alias} · ${connectedAliases.includes(agent.alias) ? "已连接" : "岛上可见"}`}
                onClick={() => setSelectedAgentId(agent.id)}
              >
                <img src="/poop-island-agent-v1.webp" alt="" />
                <span><b>{agent.alias}</b><small><i /> {connectedAliases.includes(agent.alias) ? "已连接" : "岛上可见"}</small></span>
              </button>
            ))}
          </section>
          <section>
            <h3>可以逛逛 {Math.min(2, friendAliases.length)}</h3>
            <div className="island-encounters">
              {islandAgents.slice(1, 3).map((agent) => (
                <button key={agent.id} onClick={() => setSelectedAgentId(agent.id)}>
                  <img src="/poop-island-agent-v1.webp" alt="" /><span>{agent.alias}</span>
                </button>
              ))}
            </div>
          </section>
          <p className="island-privacy">▣ Agent 只分享主人明确允许的内容</p>
        </aside>
        </details>
      </div>

      <ComposeDialog open={active && composeOpen} onClose={() => { if (!busy) setComposeOpen(false); }} title="由 Agent 代你发布">
        <section className="community-compose" aria-label="发布到 Agent 社区">
          <select aria-label="社区主题" value={topic} onChange={(event) => setTopic(event.target.value as CommunityPost["topic"])}>
            <option value="hydration">喝水</option><option value="diet">饮食</option>
            <option value="routine">生活规律</option><option value="encouragement">互相鼓励</option>
          </select>
          <textarea aria-label="公开内容" maxLength={280} value={postContent} onChange={(event) => setPostContent(event.target.value)} placeholder="只写你愿意公开的话，不会自动带入健康记录" />
          <label><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} /> 我确认公开这段文字；不包含原始观测和家庭身份</label>
          <button disabled={busy || !consented || postContent.trim().length < 2} onClick={() => void publishPost()}>确认发布</button>
          {notice && <p role="status">{notice}</p>}
        </section>
      </ComposeDialog>
      <details className="progressive-panel social-progressive community-noticeboard" open>
        <summary><b>中央广场动态</b><span>{posts.length} 条公开内容</span></summary>
        <section className="community-feed" aria-label="Agent 社区动态">
        {posts.length ? posts.map((post) => (
          <article key={post.post_id}>
            <b>{post.agent_alias}</b><small>{communityTopicLabel(post.topic)}</small>
            <p>{post.content}</p>
            {post.can_withdraw ? <button disabled={busy} onClick={() => void withdrawPost(post.post_id)}>撤回</button> : null}
            {!post.can_withdraw ? <button disabled={busy} onClick={() => void requestConnection(post.post_id)}>让 Agent 认识一下</button> : null}
          </article>
        )) : <p>还没有动态。第一条也必须由你明确确认后才会出现。</p>}
        </section>
      </details>
      <details className="progressive-panel social-progressive">
        <summary><b>朋友码头的连接</b><span>{connections.length} 个连接</span></summary>
        <section className="community-feed" aria-label="Agent 连接">
        {connections.length ? connections.map((item) => <article key={item.connection_id}>
          <b>{item.other_agent_alias}</b><small>{agentConnectionLabel(item)}</small>
          <p>连接不共享健康记录；双方都可以随时断开。</p>
          {item.can_respond ? <div><button onClick={() => void respondConnection(item.connection_id, true)}>接受</button><button onClick={() => void respondConnection(item.connection_id, false)}>拒绝</button></div> : null}
          {item.can_end ? <button onClick={() => void endConnection(item.connection_id)}>断开</button> : null}
        </article>) : <p>还没有连接。认识邀请必须由双方分别确认。</p>}
        </section>
      </details>
      <details className="progressive-panel social-progressive island-pet-settings">
        <summary><b>我的小屋</b><span>名字、皮肤和陪伴状态</span></summary>
        {pet ? <div className="island-pet-editor">
          <img src="/poop-island-agent-v1.webp" alt={`${pet.name}，${petMoodLabel(pet.mood)}`} />
          <label>伙伴名字<input aria-label="宠物名字" value={petName} onChange={(event) => setPetName(event.target.value)} /></label>
          <div className="pet-skins" aria-label="宠物皮肤">
            {PET_SKINS.map((skin) => {
              const unlocked = pet.unlocked_skins.includes(skin.id);
              return <button key={skin.id} disabled={busy || !unlocked} aria-pressed={pet.selected_skin === skin.id} onClick={() => void savePet(skin.id)}>{unlocked ? skin.label : `🔒 ${skin.label}`}</button>;
            })}
          </div>
          <button disabled={busy || !petName.trim()} onClick={() => void savePet()}>保存名字</button>
        </div> : <p>正在叫醒你的 Agent…</p>}
      </details>
      {notice && !composeOpen && (
        <div className="social-toast" role="status">
          {notice}
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
    </section>
  );
}

function petMoodLabel(value: PetSnapshot["mood"]) {
  return { curious: "好奇观察中", cheerful: "精神很好", concerned: "有点担心你" }[value];
}

function petStageLabel(value: PetSnapshot["stage"]) {
  return { new_friend: "新朋友", companion: "陪伴期", grown_up: "成熟期" }[value];
}
function communityTopicLabel(value: CommunityPost["topic"]) {
  return { hydration: "喝水", diet: "饮食", routine: "生活规律", encouragement: "互相鼓励" }[value];
}
function agentConnectionLabel(item: AgentConnection) {
  if (item.status === "connected") return "已连接";
  if (item.status === "rejected") return "已拒绝";
  if (item.status === "ended") return "已断开";
  return item.direction === "inbound" ? "等你确认" : "等待对方确认";
}
function Correction({
  session,
  members,
  current,
  onCorrect,
}: {
  session: MemberSession;
  members: Member[];
  current: string;
  onCorrect: (s: string, m: string, c?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  if (!open)
    return (
      <button className="text-button" onClick={() => setOpen(true)}>
        纠正归属
      </button>
    );
  return (
    <div className="correction">
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">改为…</option>
        {members
          .filter((m) => m.member_id !== current)
          .map((m) => (
            <option key={m.member_id} value={m.member_id}>
              {memberName(m)}
            </option>
          ))}
      </select>
      <button
        disabled={!target}
        onClick={() => {
          onCorrect(session.session_id, target, true);
          setOpen(false);
        }}
      >
        确认
      </button>
    </div>
  );
}
function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <article>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{unit}</span>
    </article>
  );
}

const TREND_AXES = [
  { key: "shape", label: "形状", symbol: "●" },
  { key: "color", label: "颜色", symbol: "◐" },
  { key: "odor", label: "气味", symbol: "≈" },
];

function trendDeviation(data?: TrendDimension) {
  if (!data || data.baseline_status === "insufficient") return 0;
  return Math.max(0, Math.min(1, data.baseline_deviation_rate ?? 0));
}

function trendStateLabel(data?: TrendDimension) {
  if (!data || data.baseline_status === "insufficient") return "还在认识你的日常";
  if (data.baseline_status === "within_baseline") return "和平常差不多";
  return "最近变化比较明显";
}

function categoryColor(dimension: string, category: string, index: number) {
  const colors: Record<string, Record<string, string>> = {
    shape: { normal: "#c9f5e6", hard: "#ff087f", loose: "#0964e8" },
    color: { brown: "#9b5b34", yellow: "#ffdc18", green: "#64c466", black: "#242424" },
    odor: { mild: "#c9f5e6", moderate: "#ffdc18", strong: "#ff087f" },
  };
  return colors[dimension]?.[category] ?? ["#0964e8", "#ff087f", "#ffdc18", "#c9f5e6"][index % 4];
}

function TrendMap({ trend }: { trend: Trend | null }) {
  const dimensions = trend?.dimensions ?? {};
  const weekly = trend?.weekly_series ?? [];
  const maxWeeklyCount = Math.max(1, ...weekly.map((item) => item.valid_sessions));

  return (
    <article className="trend-map" aria-label={`近 ${trend?.period_days ?? 30} 天的长期变化`}>
      <section className="weekly-rhythm" aria-label="每周可靠记录与形态变化">
        <header>
          <div><small>长期变化</small><b>每周身体节奏</b></div>
          <span>越往右越接近现在</span>
        </header>
        {weekly.length ? (
          <div className="weekly-rhythm-chart">
            {weekly.map((week) => {
              const abnormalRatio = Math.max(week.dry_ratio ?? 0, week.loose_ratio ?? 0);
              const state = week.valid_sessions === 0
                ? "empty"
                : abnormalRatio >= 0.5 ? "changed" : "usual";
              return (
                <div className={`rhythm-week ${state}`} key={week.week_start}>
                  <div className="rhythm-bar" style={{ height: `${28 + week.valid_sessions / maxWeeklyCount * 72}%` }}>
                    <i style={{ height: `${Math.round(abnormalRatio * 100)}%` }} />
                  </div>
                  <b>{week.valid_sessions}</b>
                  <small>{new Date(`${week.week_start}T00:00:00`).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small>
                </div>
              );
            })}
          </div>
        ) : <p className="muted">可靠记录积累后，这里会显示每周变化。</p>}
        <div className="weekly-rhythm-legend"><span><i />和平常相近</span><span><i />偏干或偏稀较多</span></div>
      </section>
      {TREND_AXES.map((axis) => {
        const data = dimensions[axis.key];
        const ratios = Object.entries(data?.category_ratios ?? {});
        const deviation = trendDeviation(data);
        const recentPosition = data?.baseline_status === "insufficient" ? 50 : 12 + deviation * 76;
        return (
          <section className={`trend-lane ${axis.key}`} key={axis.key} aria-label={`${axis.label}长期变化`}>
            <div className="trend-lane-icon" aria-hidden="true">{axis.symbol}</div>
            <div className="trend-lane-main">
              <header>
                <b>{axis.label}</b>
                <span className={data?.baseline_status ?? "insufficient"}>{trendStateLabel(data)}</span>
              </header>
              <div className="trend-track" aria-hidden="true">
                <i style={{ width: `${recentPosition}%` }} />
                <em style={{ left: `${recentPosition}%` }} />
                <small>日常</small><small>最近</small>
              </div>
              <div className="trend-legend">
                {ratios.length ? ratios.map(([category, ratio], index) => (
                  <span key={category}>
                    <i style={{ background: categoryColor(axis.key, category, index) }} />
                    {categoryLabel(category)} <b>{Math.round(ratio * 100)}%</b>
                  </span>
                )) : <span>可靠记录积累中</span>}
              </div>
            </div>
          </section>
        );
      })}
    </article>
  );
}

function categoryLabel(value: string) {
  return (
    (
      {
        normal: "正常",
        hard: "偏硬",
        loose: "偏稀",
        brown: "棕色",
        moderate: "中等",
        mild: "轻微",
        strong: "明显",
        yellow: "黄色",
        green: "绿色",
        black: "黑色",
        unknown: "待判断",
      } as Record<string, string>
    )[value] ?? value
  );
}
function agentActionLabel(value: string) {
  return (
    (
      {
        agent_chat_response: "医生回复",
        redline_notification: "红线通知",
        llm_send_check_in: "主动关心",
        llm_no_action: "保持安静",
        llm_redline_notification: "红线调度",
      } as Record<string, string>
    )[value] ?? value
  );
}

function agentRoleLabel(value: string) {
  return ({
    main_agent: "主 Agent",
    health_doctor: "健康医生",
    life_coach: "生活教练",
    household_steward: "家庭管家",
  } as Record<string, string>)[value] ?? value;
}

function contextDomainLabel(value: string) {
  return ({
    current_session: "本次可靠传感结果",
    trend: "趋势摘要",
    recent_assessments: "近期可靠评估",
    visible_memory: "已授权记忆",
    self_report_memory: "用户自报记忆",
    household_scope: "家庭空间信息",
  } as Record<string, string>)[value] ?? value;
}

function skillLabel(value: string) {
  return ({
    route_request: "理解并委派",
    explain_record: "解释记录",
    summarize_trend: "总结趋势",
    health_education: "健康解释",
    comprehensive_review: "多方面联合分析",
    lifestyle_coaching: "生活方式教练",
    deterministic_arbitration: "安全规则复核",
    urgent_care: "红线安全处理",
    send_check_in: "主动关怀",
    manage_household: "家庭事务",
  } as Record<string, string>)[value] ?? value;
}
function agentActionStatus(value: string) {
  return (
    (
      {
        succeeded: "已完成",
        pending: "待执行",
        processing: "执行中",
        failed: "失败",
        cancelled_by_revocation: "授权撤回",
        cancelled_by_assignment_correction: "归属已纠正",
      } as Record<string, string>
    )[value] ?? value
  );
}
function Settings({
  active,
  config,
  members,
  selectedMember,
  onSave,
  onMembersChanged,
}: {
  active: boolean;
  config: AppConfig;
  members: Member[];
  selectedMember: string;
  onSave: (c: AppConfig) => void;
  onMembersChanged: () => void;
}) {
  const [draft, setDraft] = useState(config);
  const [devices, setDevices] = useState<Device[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentActions, setAgentActions] = useState<AgentActionRecord[]>([]);
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  const serverAgentProfile = useRef<AgentProfile | null>(null);
  const refreshVersion = useRef(0);
  const writing = useRef(false);
  const [profileHistory, setProfileHistory] = useState<AgentProfileRevision[]>([]);
  const [rawAuthorizations, setRawAuthorizations] = useState<RawDataAuthorization[]>([]);
  const [rawConsent, setRawConsent] = useState(false);
  const [rawTypes, setRawTypes] = useState<string[]>(["odor"]);
  const [rawPurpose, setRawPurpose] = useState("改进传感分类模型");
  const [rawRetentionDays, setRawRetentionDays] = useState(7);
  const [newMemberName, setNewMemberName] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [settingsBusy, setSettingsBusyState] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsRefreshError, setSettingsRefreshError] = useState("");
  const [deviceOpen, setDeviceOpen] = useState(false);
  const activeGrant = grants.find(
    (item) => item.status === "active" && item.viewer_user_id === "u_viewer",
  );
  const grantOn = Boolean(activeGrant);
  const setSettingsBusy = useCallback((value: boolean) => {
    writing.current = value;
    if (value) refreshVersion.current += 1;
    setSettingsBusyState(value);
  }, []);
  const applyAgentProfileSnapshot = useCallback((next: AgentProfile | null, previous = serverAgentProfile.current) => {
    serverAgentProfile.current = next;
    setAgentProfile(current => {
      if (!current || !previous || !next || current.member_id !== next.member_id) return next;
      return {
        ...next,
        display_name: current.display_name === previous.display_name ? next.display_name : current.display_name,
        tone: current.tone === previous.tone ? next.tone : current.tone,
        relationship_goal: current.relationship_goal === previous.relationship_goal ? next.relationship_goal : current.relationship_goal,
        proactive_enabled: current.proactive_enabled === previous.proactive_enabled ? next.proactive_enabled : current.proactive_enabled,
        quiet_start: current.quiet_start === previous.quiet_start ? next.quiet_start : current.quiet_start,
        quiet_end: current.quiet_end === previous.quiet_end ? next.quiet_end : current.quiet_end,
      };
    });
  }, []);
  useEffect(() => {
    if (!active || settingsBusy) return;
    let current = true;
    const version = ++refreshVersion.current;
    Promise.allSettled([
      api.devices(config),
      selectedMember ? api.grants(config, selectedMember) : Promise.resolve([]),
      api.agentStatus(config),
      api.agentActions(config),
      selectedMember ? api.agentProfile(config, selectedMember) : Promise.resolve(null),
      selectedMember ? api.agentProfileHistory(config, selectedMember) : Promise.resolve([]),
      api.rawDataAuthorizations(config).catch((caught) => caught instanceof ApiError && caught.status === 404 ? [] : Promise.reject(caught)),
    ])
      .then(([nextDevices, nextGrants, nextAgentStatus, nextAgentActions, nextAgentProfile, nextHistory, nextRawAuthorizations]) => {
        if (!current || writing.current || version !== refreshVersion.current) return;
        if (nextDevices.status === "fulfilled") setDevices(nextDevices.value);
        if (nextGrants.status === "fulfilled") setGrants(nextGrants.value);
        if (nextAgentStatus.status === "fulfilled") setAgentStatus(nextAgentStatus.value);
        if (nextAgentActions.status === "fulfilled") setAgentActions(nextAgentActions.value);
        if (nextAgentProfile.status === "fulfilled") applyAgentProfileSnapshot(nextAgentProfile.value);
        if (nextHistory.status === "fulfilled") setProfileHistory(nextHistory.value);
        if (nextRawAuthorizations.status === "fulfilled") setRawAuthorizations(nextRawAuthorizations.value);
        const failed = [nextDevices, nextGrants, nextAgentStatus, nextAgentActions, nextAgentProfile, nextHistory, nextRawAuthorizations].find(result => result.status === "rejected");
        setSettingsRefreshError(failed?.status === "rejected" ? `部分设置未能更新，可能仍显示上次状态。${friendlyError(failed.reason)}` : "");
      });
    return () => {
      current = false;
    };
  }, [active, settingsBusy, config, selectedMember, applyAgentProfileSnapshot]);
  const device = devices[0];
  const currentMember = members.find(member => member.member_id === selectedMember);
  const currentName = currentMember ? memberName(currentMember) : "当前成员";
  async function toggleGrant() {
    if (!selectedMember || writing.current) return;
    setSettingsBusy(true);
    setSettingsError("");
    try {
      if (activeGrant) await api.revokeGrant(config, activeGrant.grant_id);
      else await api.createGrant(config, selectedMember, "u_viewer");
      setGrants(await api.grants(config, selectedMember));
    } catch (caught) {
      setSettingsError(friendlyError(caught));
    } finally {
      setSettingsBusy(false);
    }
  }
  async function saveAgentProfile() {
    if (!agentProfile || !selectedMember || writing.current) return;
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const updated = await api.updateAgentProfile(config, selectedMember, agentProfile);
      applyAgentProfileSnapshot(updated, agentProfile);
      setProfileHistory(await api.agentProfileHistory(config, selectedMember));
    } catch (caught) {
      setSettingsError(friendlyError(caught));
    } finally {
      setSettingsBusy(false);
    }
  }
  async function createRawAuthorization() {
    if (!device || !rawConsent || !rawTypes.length || writing.current) return;
    setSettingsBusy(true); setSettingsError("");
    try {
      await api.createRawDataAuthorization(config, device.device_id, rawPurpose, rawTypes, rawRetentionDays);
      setRawAuthorizations(await api.rawDataAuthorizations(config));
      setRawConsent(false);
    } catch (caught) { setSettingsError(friendlyError(caught)); }
    finally { setSettingsBusy(false); }
  }
  async function addMember() {
    const name = newMemberName.trim();
    if (!name || writing.current) return;
    setSettingsBusy(true); setSettingsError("");
    try {
      await api.createMember(config, name);
      setNewMemberName(""); setAddingMember(false); onMembersChanged();
    } catch (caught) { setSettingsError(friendlyError(caught)); }
    finally { setSettingsBusy(false); }
  }
  async function revokeRawAuthorization(authorizationId: string) {
    if (writing.current) return;
    setSettingsBusy(true); setSettingsError("");
    try {
      await api.revokeRawDataAuthorization(config, authorizationId);
      setRawAuthorizations(await api.rawDataAuthorizations(config));
    } catch (caught) { setSettingsError(friendlyError(caught)); }
    finally { setSettingsBusy(false); }
  }
  async function completeRawDeletion(authorizationId: string) {
    if (writing.current) return;
    setSettingsBusy(true); setSettingsError("");
    try {
      await api.completeRawDataDeletion(config, authorizationId);
      setRawAuthorizations(await api.rawDataAuthorizations(config));
    } catch (caught) { setSettingsError(friendlyError(caught)); }
    finally { setSettingsBusy(false); }
  }
  return (
    <section className="page settings settings-page">
      <header className="settings-intro"><div><small>MY CORNER</small><h1>{currentMember ? `${currentName} 的小窝` : "我的小窝"}</h1><p>家人、设备和我的偏好，都收在这里。</p></div><div className="settings-keeper"><img src="/poopsense-mascot-pop-v1.webp" alt="" /><span>慢慢了解你</span></div></header>
      {(settingsError || settingsRefreshError) && <p className="chat-error" role="alert">{[settingsError, settingsRefreshError].filter(Boolean).join(" ")}</p>}
      <div className="profile-grid">
        <article className="manage-card family-card">
          <span className="sticker">FAMILY</span>
          <h2>家庭成员</h2>
          {members.map((member) => (
            <div className="member-line" key={member.member_id}>
              <span className="avatar">{memberName(member).slice(0, 1)}</span>
              <span>
                <b>{memberName(member)}</b>
                <small>
                  {member.linked_to_current_user ? "我的档案" : "家庭成员"}
                </small>
              </span>
              <em>{member.linked_to_current_user ? "本人" : "已加入"}</em>
            </div>
          ))}
          {addingMember ? (
            <div className="add-member-form">
              <label>成员姓名<input autoFocus value={newMemberName} onChange={(event) => setNewMemberName(event.target.value)} /></label>
              <button disabled={settingsBusy || !newMemberName.trim()} onClick={() => void addMember()}>确认添加</button>
              <button disabled={settingsBusy} onClick={() => { setAddingMember(false); setNewMemberName(""); }}>取消</button>
            </div>
          ) : <button onClick={() => setAddingMember(true)}>＋ 添加家庭成员</button>}
        </article>
        <article className="device-card">
          <span className="sticker">DEVICE</span>
          <div className="device-visual">
            <img
              src="/poopsense-device-pop-v2.webp"
              loading="lazy"
              decoding="async"
              alt="PoopSense 智能马桶座圈"
            />
          </div>
          <div>
            <h2>浴室 PoopSense</h2>
            <p>
              <i /> {device?.status === "online" ? "在线" : "未连接"} ·{" "}
              {device?.last_seen_at ? "已同步" : "暂无数据"}
            </p>
            <small>
              固件 {device?.firmware_version ?? "未知"} · 原始数据授权可单独管理
            </small>
            {deviceOpen && (
              <p className="device-details">
                设备 ID：{device?.device_id ?? "暂无设备"}
                <br />
                模型：{device?.model_version ?? "未知"}
                <br />
                最近同步：
                {device?.last_seen_at
                  ? new Date(device.last_seen_at).toLocaleString("zh-CN")
                  : "暂无"}
              </p>
            )}
          </div>
          <button onClick={() => setDeviceOpen((value) => !value)}>
            {deviceOpen ? "收起详情 ↑" : "设备详情 →"}
          </button>
        </article>
        <article className="manage-card privacy-card">
          <span className="sticker">PRIVACY</span>
          <h2>查看与红线通知</h2>
          <div className="permission-line">
            <span>
              <b>家庭查看者 {grantOn ? "可查看" : "不可查看"} {currentName} 的趋势</b>
              <small>
                {grantOn
                  ? "包含可靠识别红线的同步通知"
                  : "读取和后续通知均已停止"}
              </small>
            </span>
            <button
              onClick={() => void toggleGrant()}
              disabled={settingsBusy}
              className={`toggle ${grantOn ? "active" : ""}`}
              aria-label={`家庭查看授权已${grantOn ? "开启" : "关闭"}`}
            />
          </div>
          <p className="privacy-note">关闭后，读取权限和后续通知会立即停止。</p>
          <details>
            <summary>管理授权记录</summary>
            {grants.map((grant) => (
              <p key={grant.grant_id}>
                v{grant.version} · {grant.status} ·{" "}
                {new Date(grant.granted_at).toLocaleDateString("zh-CN")}
              </p>
            ))}
          </details>
        </article>
        {agentProfile ? (
          <article className="manage-card agent-soul-card">
          <details className="settings-fold">
            <summary>
            <span className="sticker">伙伴</span>
            <h2>你的健康伙伴</h2><small>称呼、语气与提醒偏好</small></summary>
            <div className="settings-fold-body">
            <label>
              怎么称呼它
              <input value={agentProfile.display_name} onChange={(event) => setAgentProfile({ ...agentProfile, display_name: event.target.value })} />
            </label>
            <label>
              希望它怎么和你说话
              <input value={agentProfile.tone} onChange={(event) => setAgentProfile({ ...agentProfile, tone: event.target.value })} />
            </label>
            <label>
              希望它长期帮你什么
              <input value={agentProfile.relationship_goal} onChange={(event) => setAgentProfile({ ...agentProfile, relationship_goal: event.target.value })} />
            </label>
            <div className="permission-line">
              <span><b>允许主动提醒</b><small>每天最多 1 次；严重风险提醒仍会及时出现</small></span>
              <button className={`toggle ${agentProfile.proactive_enabled ? "active" : ""}`} aria-label={`主动关怀已${agentProfile.proactive_enabled ? "开启" : "关闭"}`} onClick={() => setAgentProfile({ ...agentProfile, proactive_enabled: !agentProfile.proactive_enabled })} />
            </div>
            <div className="quiet-hours">
              <label>从几点开始安静<input type="time" value={agentProfile.quiet_start} onChange={(event) => setAgentProfile({ ...agentProfile, quiet_start: event.target.value })} /></label>
              <label>几点恢复提醒<input type="time" value={agentProfile.quiet_end} onChange={(event) => setAgentProfile({ ...agentProfile, quiet_end: event.target.value })} /></label>
            </div>
            <button disabled={settingsBusy} onClick={() => void saveAgentProfile()}>保存伙伴设置</button>
            <details>
              <summary>它为什么这样回应 · 修改记录</summary>
              {agentProfile.explanation_basis.map((basis) => <p key={basis}>{basis}</p>)}
              {profileHistory.map((revision) => (
                <p key={revision.version}>
                  v{revision.version} · {revision.snapshot.display_name} · {revision.snapshot.soul.tone ?? "默认语气"} · {new Date(revision.created_at).toLocaleString("zh-CN")}
                </p>
              ))}
            </details>

            </div>
          </details>
        </article>
        ) : null}
        <article className="manage-card raw-data-card">
          <details className="settings-fold">
            <summary>
          <span className="sticker">RAW DATA</span>
          <h2>原始数据专项授权</h2><small>用途、期限与单独同意</small></summary>
            <div className="settings-fold-body">
          <p className="privacy-note">默认仅保存在设备本地。此授权不影响基础健康功能，也不包含家庭查看权限。</p>
          {rawAuthorizations.length ? rawAuthorizations.map((item) => (
            <div className="raw-authorization-line" key={item.authorization_id}>
              <span>
                <b>{item.purpose}</b>
                <small>{item.data_types.join("、")} · 保留 {item.retention_days} 天 · 已登记 {item.upload_count} 个对象</small>
                <small>状态：{item.status === "active" ? "上传许可中" : item.status === "expired" ? "已到期" : "已撤回"} · 删除：{item.deletion_status === "pending" ? "等待删除" : item.deletion_status === "completed" ? "已完成" : "无需删除"}</small>
              </span>
              {item.status === "active" ? <button disabled={settingsBusy} onClick={() => void revokeRawAuthorization(item.authorization_id)}>撤回并停止上传</button> : null}
              {item.deletion_status === "pending" ? <button disabled={settingsBusy} onClick={() => void completeRawDeletion(item.authorization_id)}>删除云端副本</button> : null}
            </div>
          )) : <p>当前没有原始数据上传授权。</p>}
          {!rawAuthorizations.some((item) => item.status === "active") ? (
            <div className="raw-consent-form">
              <label>上传用途<input value={rawPurpose} onChange={(event) => setRawPurpose(event.target.value)} /></label>
              <label>保留期限
                <select value={rawRetentionDays} onChange={(event) => setRawRetentionDays(Number(event.target.value))}>
                  <option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option>
                </select>
              </label>
              <fieldset><legend>允许的数据类型</legend>
                {[{ id: "odor", label: "气味" }, { id: "spectral", label: "光谱" }, { id: "thermal", label: "热成像" }, { id: "presence", label: "在场状态" }].map((option) => (
                  <label key={option.id}><input type="checkbox" checked={rawTypes.includes(option.id)} onChange={(event) => setRawTypes((current) => event.target.checked ? [...current, option.id] : current.filter((item) => item !== option.id))} />{option.label}</label>
                ))}
              </fieldset>
              <label className="raw-explicit-consent"><input type="checkbox" checked={rawConsent} onChange={(event) => setRawConsent(event.target.checked)} />我已了解用途、类型和期限，并单独同意限期上传</label>
              <button disabled={settingsBusy || !device || !rawConsent || !rawTypes.length || rawPurpose.trim().length < 4} onClick={() => void createRawAuthorization()}>开启限期上传</button>
            </div>
          ) : null}

            </div>
          </details>
        </article>
        <article className="manage-card agent-activity-card">
          <details className="settings-fold">
            <summary>
          <span className="sticker">AGENT</span>
          <h2>Agent 活动</h2><small>连接状态与活动记录</small></summary>
            <div className="settings-fold-body">
          <p className="privacy-note">
            {agentStatus?.configured
              ? `${agentStatus.model} 已连接`
              : "模型未连接"}{" "}
            ·{" "}
            {agentStatus?.proactive_enabled ? "主动调度开启" : "主动调度未运行"}
          </p>
          {agentActions.length ? (
            agentActions.slice(0, 5).map((action) => (
              <div className="agent-action-line" key={action.action_id}>
                <span>
                  <b>{agentActionLabel(action.action_type)}</b>
                  <small>
                    {new Date(action.created_at).toLocaleString("zh-CN")}
                  </small>
                </span>
                <em>{agentActionStatus(action.status)}</em>
              </div>
            ))
          ) : (
            <p>还没有 Agent 行动记录。</p>
          )}

            </div>
          </details>
        </article>
      </div>
      <details className="advanced-settings">
        <summary>开发连接设置</summary>
        <div className="form-card">
          <label>
            API 地址
            <input
              value={draft.apiBase}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  apiBase: e.target.value,
                })
              }
            />
          </label>
          <label>
            家庭 ID
            <input
              value={draft.householdId}
              onChange={(e) =>
                setDraft({ ...draft, householdId: e.target.value })
              }
            />
          </label>
          <label>
            家庭访问密钥
            <input
              type="password"
              value={draft.householdKey}
              onChange={(e) =>
                setDraft({ ...draft, householdKey: e.target.value })
              }
            />
          </label>
          <button className="comic-button wide" onClick={() => onSave({ ...draft, apiBase: draft.apiBase.trim().replace(/\/+$/, "") })}>
            保存并重新连接
          </button>
        </div>
      </details>
    </section>
  );
}
