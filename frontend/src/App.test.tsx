import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api, ApiError } from "./api";

vi.mock("./api", async () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      members: vi.fn(),
      simulationStatus: vi.fn().mockResolvedValue({ enabled: false }),
      simulateSensor: vi.fn(),
      createMember: vi.fn(),
      inbox: vi.fn(),
      trend: vi.fn(),
      actionFollowups: vi.fn(),
      updateActionFollowup: vi.fn(),
      sessions: vi.fn(),
      weeklyReports: vi.fn(),
      generateWeeklyReport: vi.fn(),
      rawDataAuthorizations: vi.fn(),
      createRawDataAuthorization: vi.fn(),
      revokeRawDataAuthorization: vi.fn(),
      completeRawDataDeletion: vi.fn(),
      claim: vi.fn(),
      agentChat: vi.fn(),
      analyzeSession: vi.fn(),
      deliverWater: vi.fn(),
      pickupWater: vi.fn(),
      robotTask: vi.fn(),
      confirmRobotHandover: vi.fn(),
      stopRobot: vi.fn(),
      devices: vi.fn(),
      grants: vi.fn(),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      agentStatus: vi.fn(),
      agentRun: vi.fn(),
      resumeAgentRun: vi.fn(),
      agentSkills: vi.fn(),
      conversations: vi.fn(),
      conversation: vi.fn(),
      agentActions: vi.fn(),
      agentProfile: vi.fn(),
      updateAgentProfile: vi.fn(),
      agentProfileHistory: vi.fn(),
      notifications: vi.fn(),
      readNotification: vi.fn(),
      acknowledgeNotification: vi.fn(),
      memory: vi.fn(),
      addMemory: vi.fn(),
      updateMemory: vi.fn(),
      healthProfile: vi.fn(),
      updateHealthProfile: vi.fn(),
      rateAgentMessage: vi.fn(),
      pet: vi.fn(),
      checkInPet: vi.fn(),
      updatePet: vi.fn(),
      communityPosts: vi.fn(),
      publishCommunityPost: vi.fn(),
      withdrawCommunityPost: vi.fn(),
      agentConnections: vi.fn(),
      requestAgentConnection: vi.fn(),
      respondAgentConnection: vi.fn(),
      endAgentConnection: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  mocked.simulationStatus.mockResolvedValue({ enabled: false });
  mocked.members.mockResolvedValue([
    { member_id: "m_001", display_name: "小风", linked_to_current_user: true },
    { member_id: "m_002", display_name: "家人", linked_to_current_user: false },
  ]);
  mocked.createMember.mockResolvedValue({ member_id: "m_003", display_name: "奶奶", linked_to_current_user: false });
  mocked.inbox.mockResolvedValue([
    {
      session_id: "ses_1",
      received_at: "2026-08-24T08:00:00Z",
      candidates: [],
      assignment_version: 1,
    },
  ]);
  mocked.trend.mockResolvedValue({
    household_id: "hh_001",
    member_id: "m_001",
    period_days: 30,
    assigned_sessions: 2,
    valid_sessions: 1,
    valid_sample_coverage: 0.5,
    insufficient_coverage: false,
    frequency_per_week: 0.23,
    consecutive_abnormal: 0,
    dimensions: {
      shape: {
        total: 1,
        categories: { normal: 1 },
        category_ratios: { normal: 1 },
        baseline_category: null,
        baseline_sample_count: 0,
        recent_sample_count: 1,
        baseline_deviation_rate: null,
        baseline_status: "insufficient",
      },
    },
    baseline_progress: {
      status: "collecting", current_valid_sessions: 1,
      required_valid_sessions: 5, remaining_sessions: 4,
      message: "基线积累中，再获得 4 次可靠记录后开始个人比较。",
    },
    weekly_series: [{
      week_start: "2026-08-17", week_end: "2026-08-23",
      assigned_sessions: 2, valid_sessions: 1, coverage: 0.5,
      normal_ratio: 1, dry_ratio: 0, loose_ratio: 0, dominant_shape: "normal",
    }],
    latest_change: {
      status: "insufficient", previous_shape: null, current_shape: "normal",
      message: "还需要至少两次可靠记录，才能比较前后变化。",
    },
  });
  mocked.actionFollowups.mockResolvedValue([]);
  mocked.sessions.mockResolvedValue([]);
  mocked.weeklyReports.mockResolvedValue([]);
  mocked.generateWeeklyReport.mockResolvedValue({
    report_id: "weekly_1", member_id: "m_001",
    period_start: "2026-08-24", period_end: "2026-08-30",
    status: "insufficient",
    facts: { valid_sessions: 1, coverage: 0.5, frequency_per_week: 1,
      consecutive_abnormal: 0, dimensions: {} },
    summary: "本周可靠样本不足，暂不做趋势判断。继续积累记录后再回看。",
    recommendations: ["保持自然记录，不必为凑数据改变生活习惯"],
    policy_version: "safety-v1", model_version: "policy-engine",
    created_at: "2026-08-29T00:00:00Z",
  });
  mocked.claim.mockResolvedValue({});
  mocked.devices.mockResolvedValue([{ device_id: "dev_001", household_id: "hh_001", active: true,
    status: "online", firmware_version: "0.3.0", model_version: "edge-0.2.0",
    last_seen_at: "2026-08-29T00:00:00Z", privacy_mode: "local_raw_data" }]);
  mocked.rawDataAuthorizations.mockResolvedValue([]);
  mocked.createRawDataAuthorization.mockResolvedValue({
    authorization_id: "rawauth_1", device_id: "dev_001", purpose: "改进传感分类模型",
    data_types: ["odor"], retention_days: 7, status: "active", deletion_status: "not_required",
    upload_count: 0, granted_at: "2026-08-29T00:00:00Z", expires_at: "2026-09-05T00:00:00Z",
    revoked_at: null, deleted_at: null,
  });
  mocked.grants.mockResolvedValue([]);
  mocked.agentStatus.mockResolvedValue({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    configured: true,
    proactive_enabled: true,
    policy_version: "safety-v1",
    worker_enabled: true,
    worker_running: true,
    worker_last_run_at: null,
    worker_last_error: null,
    worker_processed_total: 0,
    skills: ["urgent_care"],
    agents: ["main_agent", "health_doctor"],
  });
  mocked.conversations.mockResolvedValue([]);
  mocked.agentActions.mockResolvedValue([]);
  mocked.agentProfileHistory.mockResolvedValue([]);
  mocked.notifications.mockResolvedValue([]);
  mocked.agentProfile.mockResolvedValue({
    member_id: "m_001", scope: "member", display_name: "小风的 PoopSense",
    tone: "温和直接", relationship_goal: "长期陪伴", proactive_enabled: true,
    daily_non_redline_limit: 1, quiet_start: "22:00", quiet_end: "08:00",
    timezone: "Asia/Shanghai", version: 1, updated_at: "2026-08-29T00:00:00Z",
    explanation_basis: [],
  });
  mocked.memory.mockResolvedValue([]);
  mocked.healthProfile.mockResolvedValue({
    member_id: "m_001", conditions: [], diet_pattern: "", sleep_pattern: "",
    medications: [], goals: [], completeness: 0, updated_at: null,
  });
  mocked.updateHealthProfile.mockImplementation(async (_config, _memberId, profile) => ({
    ...profile, member_id: "m_001", completeness: 1,
    updated_at: "2026-08-28T00:00:00Z",
  }));
  mocked.rateAgentMessage.mockResolvedValue({
    feedback_id: 1, message_id: 2, rating: "helpful", reason: null,
    updated_at: "2026-08-28T00:00:00Z",
  });
  mocked.addMemory.mockResolvedValue({
    memory_id: 1,
    logical_id: "mem_1",
    member_id: "m_001",
    version: 1,
    source_type: "self_report",
    memory_key: "饮食偏好",
    content: "很少吃辣",
    editable: true,
    correction_reason: null,
    created_at: "2026-08-28T00:00:00Z",
  });
  mocked.agentChat.mockResolvedValue({
    conversation_id: "conv_1",
    message: {
      message_id: 2,
      role: "assistant",
      content: "请尽快联系线下医生；严重症状请立即寻求急诊帮助。",
      created_at: "2026-08-27T00:00:00Z",
    },
    decision: "urgent_care",
    allowed_actions: ["recommend_urgent_care"],
    authorization_basis: "household_owner",
    policy_version: "safety-v1",
    model_version: "test-model",
    delegated_agent: "health_doctor",
    skill: "urgent_care",
    run_id: "run_1",
    skill_version: "1.0.0",
  });
  mocked.analyzeSession.mockResolvedValue({
    conversation_id: "conv_analysis",
    message: {
      message_id: 9, role: "assistant",
      content: "本次自动分析已完成。",
      created_at: "2026-08-29T12:31:00Z",
    },
    decision: "health_education",
    allowed_actions: ["explain", "provide_lifestyle_plan"],
    authorization_basis: "household_owner", policy_version: "safety-v1",
    model_version: "test-model", delegated_agent: "health_doctor",
    skill: "comprehensive_review", run_id: "run_analysis", skill_version: "1.0.0",
    report: {
      session_id: "ses_latest", generated_at: "2026-08-29T12:31:00Z",
      status: "ready", reliable: true,
      headline: "这次信号已读懂，继续保持稳定节奏",
      summary: "本次信号接近你的个人基线。",
      findings: [],
      recommendations: [
        { category: "hydration", title: "补水", guidance: "规律饮水。", timing: "today" },
        { category: "diet", title: "饮食", guidance: "保持规律吃饭。", timing: "today" },
        { category: "movement", title: "活动", guidance: "安排轻松走动。", timing: "today" },
        { category: "observation", title: "继续观察", guidance: "留意下一次变化。", timing: "next_time" },
      ],
      next_step: "下一次可靠记录会继续进入长期趋势。",
    },
  });
  mocked.pickupWater.mockResolvedValue({
    accepted: true, task: "pickup_water", task_id: "pickup_1",
    status: "starting", current_step: "starting", requires_user_action: null,
  });
  mocked.robotTask.mockResolvedValue({
    task_id: "pickup_1", status: "completed",
    progress: 1, current_step: "pickup_completed",
    message: "取水演示完成：水杯已提起，机械臂保持当前位置", requires_user_action: null,
  });
  mocked.confirmRobotHandover.mockResolvedValue({
    task_id: "delivery_1", status: "running", progress: 0.9,
    current_step: "releasing", message: "正在安全松开夹爪", requires_user_action: null,
  });
  mocked.agentRun.mockResolvedValue({
    run_id: "run_1", member_id: "m_001", trigger: "user_message",
    goal: "出现血便怎么办", status: "completed", current_step: 2,
    max_steps: 4, result: {}, error: null,
    created_at: "2026-08-28T00:00:00Z", completed_at: "2026-08-28T00:00:01Z",
    steps: [
      { step_index: 1, agent_name: "main_agent", skill_name: "route_request", skill_version: "1.0.0", status: "succeeded", output_summary: {}, started_at: null, completed_at: null, error: null },
      { step_index: 2, agent_name: "health_doctor", skill_name: "urgent_care", skill_version: "1.0.0", status: "succeeded", output_summary: {}, started_at: null, completed_at: null, error: null },
    ],
    handoffs: [],
  });
  mocked.agentSkills.mockResolvedValue([]);
  mocked.pet.mockResolvedValue({
    member_id: "m_001", name: "小噗", selected_skin: "classic",
    unlocked_skins: ["classic"], mood: "curious", stage: "new_friend",
    message: "先一起积累可靠记录。", streak_days: 0, total_checkins: 0,
    checked_in_today: false, health_basis: "insufficient", profile_version: 1,
  });
  mocked.checkInPet.mockResolvedValue({
    duplicate: false,
    pet: {
      member_id: "m_001", name: "小噗", selected_skin: "classic",
      unlocked_skins: ["classic"], mood: "curious", stage: "new_friend",
      message: "先一起积累可靠记录。", streak_days: 1, total_checkins: 1,
      checked_in_today: true, health_basis: "insufficient", profile_version: 1,
    },
  });
  mocked.updatePet.mockImplementation(async (_config, _memberId, name, selectedSkin): Promise<import("./api").PetSnapshot> => ({
    member_id: "m_001", name, selected_skin: selectedSkin,
    unlocked_skins: ["classic"], mood: "curious", stage: "new_friend",
    message: "先一起积累可靠记录。", streak_days: 0, total_checkins: 0,
    checked_in_today: false, health_basis: "insufficient", profile_version: 2,
  }));
  mocked.communityPosts.mockResolvedValue([]);
  mocked.publishCommunityPost.mockResolvedValue({
    post_id: "post_1", agent_alias: "小风的 PoopSense", topic: "hydration",
    content: "今天记得喝水", status: "active", created_at: "2026-08-29T00:00:00Z",
    can_withdraw: true,
  });
  mocked.withdrawCommunityPost.mockResolvedValue({
    post_id: "post_1", agent_alias: "小风的 PoopSense", topic: "hydration",
    content: "今天记得喝水", status: "withdrawn", created_at: "2026-08-29T00:00:00Z",
    can_withdraw: true,
  });
  mocked.agentConnections.mockResolvedValue([]);
});

describe("model routing provenance", () => {
  it.each([
    ["MODEL_NOT_CONFIGURED", "这类问题的模型暂未配置。你仍可查看记录的基础报告，稍后再来提问。"],
    ["MODEL_ROUTING_CONFIG_INVALID", "对话服务的模型配置需要维护，请稍后再试。已保存的记录仍可查看。"],
  ])("explains the routing failure %s and preserves the question for retry", async (code, explanation) => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    mocked.agentChat.mockRejectedValueOnce(new ApiError(503, code));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "颜色通常表示什么");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText(explanation)).toBeVisible();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
    expect(screen.getByText("颜色通常表示什么")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试这条提问" })).toBeEnabled();
  });

  it.each([true, false])("shows the actual answer model immediately with message version present=%s", async hasMessageVersion => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    const status = await mocked.agentStatus.getMockImplementation()!(null as never);
    mocked.agentStatus.mockResolvedValue({ ...status, model: "current-default-model", routing: { mode: "auto", profiles: [], routes: [] } });
    mocked.agentChat.mockResolvedValue({ ...response, model_version: "response-model", message: {
      ...response.message, content: "这是本次完整回复。", model_version: hasMessageVersion ? "message-model" : undefined,
      metadata: { model_route: { mode: "auto", task: "product_help", source: "model", reason: "task_route" } },
    } });
    mocked.agentRun.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "如何开始使用");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText("这是本次完整回复。")).toBeVisible();
    const source = screen.getByRole("group", { name: "回答来源" });
    expect(within(source).getByText(`本次模型：${hasMessageVersion ? "message-model" : "response-model"}`)).toBeVisible();
    expect(source).not.toHaveTextContent("current-default-model");
    expect(screen.getByRole("button", { name: "发送 →" })).not.toHaveTextContent("等待回答");
    await user.click(within(source).getByText("来源详情"));
    expect(within(source).getByText("使用帮助 · 按问题自动选择")).toBeVisible();
    expect(within(source).getByText("根据问题类型选择相应模型。")).toBeVisible();
    expect(source).not.toHaveTextContent("task_route");
  });

  it("restores each saved model and leaves legacy messages without a guessed source", async () => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const status = await mocked.agentStatus.getMockImplementation()!(null as never);
    mocked.agentStatus.mockResolvedValue({ ...status, model: "new-current-model" });
    mocked.conversations.mockResolvedValue([{ conversation_id: "saved_sources", member_id: "m_001", updated_at: "2026-09-13T00:00:00Z" }]);
    mocked.conversation.mockResolvedValue({ conversation_id: "saved_sources", member_id: "m_001", messages: [
      { message_id: 10, role: "assistant", content: "旧模型保存的回答。", created_at: "2026-09-12T00:00:00Z", model_version: "saved-model" },
      { message_id: 11, role: "assistant", content: "这条安全提醒来自规则。", created_at: "2026-09-12T00:00:01Z", model_version: "policy-engine" },
      { message_id: 12, role: "assistant", content: "旧版本没有保存模型信息。", created_at: "2026-09-12T00:00:02Z" },
    ] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("查看此前对话（3 条）"));
    const saved = screen.getByText("旧模型保存的回答。").closest(".message") as HTMLElement;
    const policy = screen.getByText("这条安全提醒来自规则。").closest(".message") as HTMLElement;
    const legacy = screen.getByText("旧版本没有保存模型信息。").closest(".message") as HTMLElement;
    expect(within(saved).getByText("本次模型：saved-model")).toBeVisible();
    expect(within(policy).getByText("规则生成")).toBeVisible();
    expect(within(legacy).queryByRole("group", { name: "回答来源" })).not.toBeInTheDocument();
    expect(saved).not.toHaveTextContent("new-current-model");
    expect(policy).not.toHaveTextContent("new-current-model");
  });

  it.each([true, false])("identifies mixed processing without crediting the whole answer to one model, multiple=%s", async multiple => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    mocked.agentChat.mockResolvedValue({ ...response, model_version: "last-model", message: {
      ...response.message, content: "已整理多方面说明。", model_version: "mixed",
      metadata: { model_route: { mode: "auto", task: "health_knowledge", source: "mixed", reason: "mixed_steps", models_used: [
        ...(multiple ? [{ provider: "deepseek", model: "deepseek-v4-pro", task: "general_chat" }] : []),
        { provider: "baichuan", model: "Baichuan-M3-Plus", task: "health_knowledge" },
      ] } },
    } });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "请综合解释");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    const source = await screen.findByRole("group", { name: "回答来源" });
    expect(within(source).getByText(multiple ? "多模型与规则共同整理" : "模型与规则共同整理")).toBeVisible();
    expect(source).not.toHaveTextContent("本次模型：");
    await user.click(within(source).getByText("来源详情"));
    if (multiple) expect(within(source).getByText("日常问答：deepseek-v4-pro")).toBeVisible();
    else expect(source).not.toHaveTextContent("deepseek-v4-pro");
    expect(within(source).getByText("健康知识：Baichuan-M3-Plus")).toBeVisible();
    expect(within(source).getByText("不同处理步骤分别完成后汇总。")).toBeVisible();
    expect(source).not.toHaveTextContent("mixed_steps");
  });

  it.each(["output_guard", "future_reason"])("labels a guarded result as policy and maps the reason %s", async reason => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    mocked.agentChat.mockResolvedValue({ ...response, model_version: "policy-engine", message: {
      ...response.message, content: "请先查看安全提醒。", model_version: "policy-engine",
      metadata: { model_route: { mode: "auto", task: reason === "output_guard" ? "urgent_care" : "future_task", source: "policy", model: "configured-but-not-used", reason } },
    } });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "如何理解安全提醒");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    const source = await screen.findByRole("group", { name: "回答来源" });
    expect(within(source).getByText("规则生成")).toBeVisible();
    expect(source).not.toHaveTextContent("configured-but-not-used");
    await user.click(within(source).getByText("来源详情"));
    expect(within(source).getByText(reason === "output_guard" ? "未通过检查的模型内容未采用。" : "按本次问题与可用配置完成处理。")).toBeVisible();
    expect(source).not.toHaveTextContent(reason);
    expect(source).not.toHaveTextContent("future_task");
  });

  it("keeps the report provenance when a later question uses a different model", async () => {
    window.history.replaceState(null, "", "/#/report?member=m_001&record=ses_latest");
    mocked.sessions.mockResolvedValue([{ session_id: "ses_latest", occurred_at: "2026-09-13T00:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "这是一条已归属记录。" }]);
    const analysis = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockResolvedValue({ ...analysis, model_version: "policy-engine", message: {
      ...analysis.message, model_version: "policy-engine", metadata: { model_route: { mode: "auto", task: "session_report", source: "policy", reason: "rule_report" } },
    } });
    const reply = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    mocked.agentChat.mockResolvedValue({ ...reply, model_version: "Baichuan-M3-Plus", message: { ...reply.message, content: "这是对建议的补充说明。", model_version: "Baichuan-M3-Plus" } });
    const user = userEvent.setup();
    render(<App />);
    const reportSource = await screen.findByRole("group", { name: "报告来源" });
    expect(within(reportSource).getByText("规则生成")).toBeVisible();
    await user.type(screen.getByLabelText("描述你的情况"), "请补充解释");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText("这是对建议的补充说明。")).toBeVisible();
    expect(within(screen.getByRole("group", { name: "回答来源" })).getByText("本次模型：Baichuan-M3-Plus")).toBeVisible();
    expect(reportSource).toHaveTextContent("规则生成");
    expect(reportSource).not.toHaveTextContent("Baichuan-M3-Plus");
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
  });

  it("shows read-only task routing and configuration without claiming connectivity", async () => {
    const status = await mocked.agentStatus.getMockImplementation()!(null as never);
    mocked.agentStatus.mockResolvedValue({ ...status, configured: false, routing: {
      mode: "auto",
      profiles: [{ id: "general", provider: "deepseek", model: "deepseek-v4-pro", configured: true }, { id: "medical", provider: "baichuan", model: "Baichuan-M3-Plus", configured: false }],
      routes: [
        { task: "general_chat", label: "日常问答", source: "model", provider: "deepseek", model: "deepseek-v4-pro", configured: true },
        { task: "health_knowledge", label: "健康知识", source: "model", provider: "baichuan", model: "Baichuan-M3-Plus", configured: false },
        { task: "session_report", label: "传感报告", source: "policy", configured: true },
      ],
    } });
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByRole("button", { name: /我的$/ }))[0]);
    await user.click(await screen.findByRole("heading", { name: "Agent 活动" }));
    const routing = await screen.findByRole("region", { name: "模型分工" });
    const activity = routing.closest("article") as HTMLElement;
    expect(within(activity).getByText(/按问题自动选择/)).toBeVisible();
    expect(within(routing).getByText("deepseek-v4-pro").closest("dd")).toHaveTextContent("已配置");
    expect(within(routing).getByText("Baichuan-M3-Plus").closest("dd")).toHaveTextContent("未配置");
    expect(within(routing).getByText("规则处理")).toBeVisible();
    expect(activity).not.toHaveTextContent("已连接");
    expect(within(routing).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(routing).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps single-model status compatible with the older API", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByRole("button", { name: /我的$/ }))[0]);
    await user.click(await screen.findByRole("heading", { name: "Agent 活动" }));
    expect(await screen.findByText(/deepseek-v4-pro 已配置/)).toBeVisible();
    expect(screen.queryByText(/deepseek-v4-pro 已连接/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "模型分工" })).not.toBeInTheDocument();
  });
});

describe("PoopSense core UI", () => {
  it("keeps a historical report inside previous conversation when opening direct chat", async () => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const prior = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "prior_record");
    mocked.analyzeSession.mockClear();
    mocked.conversations.mockResolvedValue([{ conversation_id: "history_report" }] as never);
    mocked.conversation.mockResolvedValue({ conversation_id: "history_report", messages: [{ message_id: 99,
      role: "assistant", content: "这是此前报告的说明文本", model_version: "saved-report-model",
      metadata: { report: { ...prior.report!, session_id: "prior_record", headline: "不应变成本次报告的旧结论" } },
    }] } as never);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("查看此前对话（1 条）");
    expect(screen.getByRole("heading", { name: "聊聊你的记录" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "不应变成本次报告的旧结论" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "报告来源" })).not.toBeInTheDocument();
    await user.click(screen.getByText("查看此前对话（1 条）"));
    expect(screen.getByText("这是此前报告的说明文本")).toBeVisible();
    expect(screen.getByText("本次模型：saved-report-model")).toBeVisible();
    expect(screen.getByText("PoopSense 助手")).toBeVisible();
    expect(screen.queryByText("Agent 医生")).not.toBeInTheDocument();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it.each(["current_record", "other_record"])("revalidates the requested record instead of treating historical %s as a fresh report", async historicalId => {
    window.history.replaceState(null, "", "/#/report?member=m_001&record=current_record");
    const prior = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "current_record");
    mocked.analyzeSession.mockClear();
    mocked.sessions.mockResolvedValue([{ session_id: "current_record", occurred_at: "2026-09-18T00:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "本次已归属记录" }]);
    mocked.conversations.mockResolvedValue([{ conversation_id: "history_report" }] as never);
    mocked.conversation.mockResolvedValue({ conversation_id: "history_report", messages: [{ message_id: 99,
      role: "assistant", content: "历史说明", metadata: { report: { ...prior.report!, session_id: historicalId, headline: "历史卡片不能代替本次校验" } },
    }] } as never);
    let finish!: (value: typeof prior) => void;
    mocked.analyzeSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledWith(expect.anything(), "m_001", "current_record", "history_report"));
    expect(screen.getByText("正在生成完整分析报告…")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "历史卡片不能代替本次校验" })).not.toBeInTheDocument();
    await act(async () => { finish({ ...prior, report: { ...prior.report!, session_id: "current_record", headline: "本次服务端校验结果" } }); });
    expect(screen.getByRole("heading", { name: "本次服务端校验结果" })).toBeVisible();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
  });

  it("does not label an ordinary question as report generation while history is pending", async () => {
    window.history.replaceState(null, "", "/#/report?member=m_001&record=current_record");
    mocked.sessions.mockResolvedValue([{ session_id: "current_record", occurred_at: "2026-09-18T00:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "本次已归属记录" }]);
    mocked.conversations.mockImplementation(() => new Promise(() => {}));
    mocked.agentChat.mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "先了解记录如何使用");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(screen.getByText("正在等待回答…")).toBeVisible();
    expect(screen.queryByText("正在生成完整分析报告…")).not.toBeInTheDocument();
    expect(document.querySelector(".current-result-task")).not.toHaveClass("analyzing");
    expect(mocked.agentChat).toHaveBeenCalledTimes(1);
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it("hides an existing report on direct-chat navigation without discarding the reply or draft", async () => {
    window.history.replaceState(null, "", "/#/report?member=m_001&record=ses_latest");
    mocked.sessions.mockResolvedValue([{ session_id: "ses_latest", occurred_at: "2026-09-18T00:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "本次已归属记录" }]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: /继续保持稳定节奏/ });
    const input = screen.getByLabelText("描述你的情况");
    await user.type(input, "如何理解本次建议");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    await screen.findByText("请尽快联系线下医生；严重症状请立即寻求急诊帮助。");
    await user.type(input, "准备继续问的草稿{Enter}仍在编辑");
    await act(async () => { window.location.hash = "#/chat?member=m_001"; });
    await screen.findByRole("heading", { name: "聊聊你的记录" });
    expect(screen.queryByRole("heading", { name: /继续保持稳定节奏/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "报告来源" })).not.toBeInTheDocument();
    expect(document.querySelector(".chat-panel")).not.toHaveClass("has-report");
    expect(screen.getByText("也可以从这里开始")).toBeVisible();
    expect(screen.getByText("请尽快联系线下医生；严重症状请立即寻求急诊帮助。")).toBeVisible();
    expect(input).toHaveValue("准备继续问的草稿\n仍在编辑");
    await act(async () => { window.location.hash = "#/report?member=m_001&record=ses_latest"; });
    expect(await screen.findByRole("heading", { name: /继续保持稳定节奏/ })).toBeVisible();
    expect(input).toHaveValue("准备继续问的草稿\n仍在编辑");
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    expect(mocked.agentChat).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and reading position when enlarging an earlier reply while another answer arrives", async () => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    mocked.agentChat.mockClear();
    mocked.agentChat.mockResolvedValueOnce({ ...response, message: { ...response.message, content: "保持原文的长回答。".repeat(55) } });
    let finish!: (value: typeof response) => void;
    mocked.agentChat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      const user = userEvent.setup();
      render(<App />);
      const input = await screen.findByLabelText("描述你的情况");
      await user.type(input, "请解释"); await user.click(screen.getByRole("button", { name: "发送 →" }));
      await screen.findByRole("button", { name: "放大字号" });
      await user.type(input, "第二个问题"); await user.click(screen.getByRole("button", { name: "发送 →" }));
      await user.type(input, "还没发送的多行草稿{Enter}第二行");
      scroll.mockClear();
      await user.click(screen.getByRole("button", { name: "放大字号" }));
      expect(input).toHaveValue("还没发送的多行草稿\n第二行");
      await act(async () => { finish({ ...response, message: { ...response.message, message_id: 88, content: "迟到的第二条回答" } }); });
      expect(screen.getByText("迟到的第二条回答")).toBeVisible();
      expect(scroll).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "查看刚收到的回答 ↓" })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "回到这条回答开头 ↑" }));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(input).toHaveValue("还没发送的多行草稿\n第二行");
      expect(mocked.agentChat).toHaveBeenCalledTimes(2);
    } finally {
      if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it.each(["wheel", "PageUp", "editing"] as const)("preserves reading intent when a reply arrives after %s", async action => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    mocked.agentChat.mockClear();
    let complete!: (value: typeof response) => void;
    mocked.agentChat.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      const user = userEvent.setup();
      render(<App />);
      const input = await screen.findByLabelText("描述你的情况");
      await user.type(input, "先回答这个问题");
      await user.click(screen.getByRole("button", { name: "发送 →" }));
      await user.type(input, "还没发送的草稿");
      scroll.mockClear();
      if (action === "editing") await user.keyboard("{ArrowLeft}");
      else await act(async () => {
        window.dispatchEvent(action === "wheel" ? new WheelEvent("wheel", { deltaY: -200 })
          : new KeyboardEvent("keydown", { key: "PageUp" }));
      });
      await act(async () => complete({ ...response, message: { ...response.message, content: "这是一条新收到的完整回答。" } }));
      expect(await screen.findByText("这是一条新收到的完整回答。")).toBeVisible();
      if (action === "editing") {
        expect(scroll).toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "查看刚收到的回答 ↓" })).not.toBeInTheDocument();
      } else {
        expect(scroll).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "查看刚收到的回答 ↓" }));
        expect(scroll).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: "查看刚收到的回答 ↓" })).not.toBeInTheDocument();
      }
      expect(input).toHaveValue("还没发送的草稿");
      expect(mocked.agentChat).toHaveBeenCalledTimes(1);
    } finally {
      if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it.each(["success", "failure"] as const)("keeps an early manual question's %s visible instead of starting a pending automatic report", async outcome => {
    window.history.replaceState(null, "", "/#/report?member=m_001&record=ses_latest");
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "当前记录",
    }]);
    mocked.conversations.mockImplementation(() => new Promise(() => {}));
    if (outcome === "failure") mocked.agentChat.mockRejectedValueOnce(new ApiError(502, "MODEL_RESPONSE_INCOMPLETE"));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "先回答这个问题");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    if (outcome === "failure") expect(await screen.findByRole("button", { name: "重试这条提问" })).toBeVisible();
    else expect(await screen.findByText("请尽快联系线下医生；严重症状请立即寻求急诊帮助。")).toBeVisible();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    expect(screen.getByText("先回答这个问题").closest("details")).toBeNull();
    await user.click(screen.getByRole("button", { name: "立即自动分析 →" }));
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledTimes(1));
  });
  it.each(["success", "failure"] as const)("starts a question without waiting for history and ignores its late %s", async outcome => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    let resolveHistory!: (value: never) => void;
    let rejectHistory!: (error: Error) => void;
    mocked.conversations.mockResolvedValue([{ conversation_id: "slow_old" }] as never);
    mocked.conversation.mockImplementation(() => new Promise((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject; }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "新的提问");
    expect(screen.getByText(/正在加载此前对话，也可以直接开始新的提问/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText("请尽快联系线下医生；严重症状请立即寻求急诊帮助。")).toBeVisible();
    expect(mocked.agentChat).toHaveBeenCalledWith(expect.anything(), "m_001", "新的提问", undefined);
    await act(async () => {
      if (outcome === "success") resolveHistory({ conversation_id: "slow_old", messages: [{ role: "assistant", content: "不应该覆盖新问答的旧正文", message_id: 12 }] } as never);
      else rejectHistory(new Error("old history failed"));
    });
    expect(screen.getByText("新的提问")).toBeVisible();
    expect(screen.queryByText("不应该覆盖新问答的旧正文")).not.toBeInTheDocument();
    expect(screen.queryByText(/历史对话暂时未加载/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("描述你的情况"), "第二个问题");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    await waitFor(() => expect(mocked.agentChat).toHaveBeenLastCalledWith(expect.anything(), "m_001", "第二个问题", "conv_1"));
  });

  it("does not let slow optional details block the next question or overwrite its result", async () => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    let rejectDetails!: (error: Error) => void;
    mocked.agentRun.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDetails = reject; }));
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    mocked.agentChat.mockClear();
    mocked.agentChat.mockResolvedValueOnce({ ...response, message: { ...response.message, content: "第一条完整回答" } });
    mocked.agentChat.mockResolvedValueOnce({ ...response, run_id: "new_run", message: { ...response.message, message_id: 88, content: "第二条完整回答" } });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "问题一");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText("第一条完整回答")).toBeVisible();
    await user.type(screen.getByLabelText("描述你的情况"), "问题二");
    expect(screen.getByRole("button", { name: "发送 →" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText("第二条完整回答")).toBeVisible();
    await act(async () => rejectDetails(new ApiError(404, "OLD_RUN_MISSING")));
    expect(screen.queryByText(/回复已生成，部分跟进信息暂时未加载/)).not.toBeInTheDocument();
    expect(screen.getByText("第二条完整回答")).toBeVisible();
    expect(mocked.agentChat).toHaveBeenCalledTimes(2);
  });

  it("retries a failed question without duplicating it or clearing the next draft", async () => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    mocked.agentChat.mockRejectedValueOnce(new ApiError(502, "MODEL_RESPONSE_INCOMPLETE"));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "第一次问题");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText(/这次回答没有完整生成/)).toBeVisible();
    await user.type(screen.getByLabelText("描述你的情况"), "还没发出的下一条");
    await user.click(screen.getByRole("button", { name: "重试这条提问" }));
    expect(await screen.findByText("请尽快联系线下医生；严重症状请立即寻求急诊帮助。")).toBeVisible();
    expect(screen.getAllByText("第一次问题")).toHaveLength(1);
    expect(screen.getByLabelText("描述你的情况")).toHaveValue("还没发出的下一条");
    expect(mocked.agentChat).toHaveBeenCalledTimes(2);
  });

  it("waits for explicit consent to retry an expired conversation and preserves the next draft and saved sources", async () => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    mocked.conversations.mockResolvedValue([{ conversation_id: "expired_conversation", member_id: "m_001", updated_at: "2026-09-13T00:00:00Z" }]);
    mocked.conversation.mockResolvedValue({ conversation_id: "expired_conversation", member_id: "m_001", messages: [
      { message_id: 15, role: "assistant", content: "此前已经保存的回答。", created_at: "2026-09-13T00:00:00Z", model_version: "old-saved-model" },
    ] });
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    let rejectExpired!: (reason: unknown) => void;
    mocked.agentChat.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectExpired = reject; }));
    mocked.agentChat.mockResolvedValueOnce({ ...response, conversation_id: "new_conversation", model_version: "new-top-level-model", message: {
      ...response.message, content: "这是新对话中的完整回答。", model_version: "new-actual-model",
    } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("查看此前对话（1 条）");
    await user.type(screen.getByLabelText("描述你的情况"), "需要保留的原问题");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    await user.type(screen.getByLabelText("描述你的情况"), "还没发出的下一条草稿");
    await act(async () => rejectExpired(new ApiError(409, "CONVERSATION_EXPIRED")));
    expect(await screen.findByText(/上次会话已失效/)).toBeVisible();
    expect(mocked.agentChat).toHaveBeenCalledTimes(1);
    expect(mocked.agentChat).toHaveBeenNthCalledWith(1, expect.anything(), "m_001", "需要保留的原问题", "expired_conversation");
    expect(screen.getByLabelText("描述你的情况")).toHaveValue("还没发出的下一条草稿");
    expect(screen.queryByRole("button", { name: "重试这条提问" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "在新对话中重试" }));
    expect(await screen.findByText("这是新对话中的完整回答。")).toBeVisible();
    expect(mocked.agentChat).toHaveBeenCalledTimes(2);
    expect(mocked.agentChat).toHaveBeenNthCalledWith(2, expect.anything(), "m_001", "需要保留的原问题", undefined);
    expect(screen.getAllByText("需要保留的原问题")).toHaveLength(1);
    expect(screen.getByLabelText("描述你的情况")).toHaveValue("还没发出的下一条草稿");
    const newAnswer = screen.getByText("这是新对话中的完整回答。").closest(".message") as HTMLElement;
    expect(newAnswer).toHaveTextContent("本次模型：new-actual-model");
    expect(newAnswer).not.toHaveTextContent("old-saved-model");
    expect(newAnswer).not.toHaveTextContent("new-top-level-model");
    await user.click(screen.getByText("查看此前对话（1 条）"));
    expect(screen.getByText("此前已经保存的回答。").closest(".message")).toHaveTextContent("本次模型：old-saved-model");
  });

  it("requires an explicit new conversation retry for an expired report request too", async () => {
    window.history.replaceState(null, "", "/#/report?member=m_001&record=expired_report");
    mocked.sessions.mockResolvedValue([{ session_id: "expired_report", occurred_at: "2026-09-13T00:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "已经归属的本次记录。" }]);
    mocked.conversations.mockResolvedValue([{ conversation_id: "expired_report_conversation", member_id: "m_001", updated_at: "2026-09-13T00:00:00Z" }]);
    mocked.conversation.mockResolvedValue({ conversation_id: "expired_report_conversation", member_id: "m_001", messages: [] });
    mocked.analyzeSession.mockRejectedValueOnce(new ApiError(409, "CONVERSATION_EXPIRED"));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/上次会话已失效/)).toBeVisible();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    expect(mocked.analyzeSession).toHaveBeenNthCalledWith(1, expect.anything(), "m_001", "expired_report", "expired_report_conversation");
    await user.type(screen.getByLabelText("描述你的情况"), "稍后要问的草稿");
    await user.click(screen.getByRole("button", { name: "在新对话中重试" }));
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledTimes(2));
    expect(mocked.analyzeSession).toHaveBeenNthCalledWith(2, expect.anything(), "m_001", "expired_report", undefined);
    expect(screen.getByLabelText("描述你的情况")).toHaveValue("稍后要问的草稿");
    expect(mocked.agentChat).not.toHaveBeenCalled();
  });

  it("claims a pending session only after a member is selected", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    expect(await screen.findByText("有 1 次记录等你确认")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "确认归属" });
    expect(button).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("这是谁的记录？"), "m_001");
    await user.click(button);
    await waitFor(() =>
      expect(mocked.claim).toHaveBeenCalledWith(
        expect.anything(),
        "ses_1",
        "m_001",
        false,
      ),
    );
  });

  it("renders factual category ratios without averaging categories", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "趋势" }));
    expect(await screen.findByLabelText("形状长期变化")).toHaveTextContent("还在认识你的日常");
    expect(screen.getByText("正常")).toBeVisible();
  });

  it("clears old member feedback immediately while the next member loads", async () => {
    mocked.actionFollowups.mockImplementation(async (_config, memberId) => memberId === "m_001" ? [{
      followup_id: "old_member_followup", member_id: "m_001", source_session_id: "old",
      adoption_status: "suggested", perceived_outcome: "pending", observed_outcome: "pending",
      observed_outcome_note: "仅属于小风的跟进内容",
    }] as never : new Promise(() => {}));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "行动" }));
    await user.click(await screen.findByText("查看原记录与对照依据", { selector: "summary" }));
    expect(await screen.findByText("仅属于小风的跟进内容")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("查看哪位成员"), "m_002");
    expect(screen.queryByText("仅属于小风的跟进内容")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "我会试试" })).not.toBeInTheDocument();
  });

  it("refreshes followup after a historical record arrives while staying on health", async () => {
    const latest = { session_id: "latest", occurred_at: "2026-09-01T00:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "最新记录" };
    mocked.sessions.mockResolvedValue([latest]);
    mocked.actionFollowups.mockResolvedValue([{ followup_id: "f", adoption_status: "accepted", observed_outcome: "pending", perceived_outcome: "pending" }] as never);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "看看这次结果 →" });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "行动" }));
    expect(await screen.findByRole("heading", { name: "等下一次可靠记录自动回看" })).toBeVisible();
    await user.click(screen.getByText("查看原记录与对照依据", { selector: "summary" }));
    mocked.sessions.mockResolvedValue([latest, { ...latest, session_id: "late_upload", occurred_at: "2026-08-31T00:00:00Z" }]);
    mocked.actionFollowups.mockResolvedValue([{ followup_id: "f", adoption_status: "accepted", observed_outcome: "same", perceived_outcome: "pending", observed_outcome_note: "补传后已重新比较" }] as never);
    expect(await screen.findByText("补传后已重新比较", {}, { timeout: 6500 })).toBeVisible();
  }, 10000);

  it("prioritizes adopted followup and lets users inspect a newer suggestion", async () => {
    mocked.actionFollowups.mockResolvedValue([
      { followup_id: "new", source_session_id: "new_source", adoption_status: "suggested", observed_outcome: "pending", perceived_outcome: "pending" },
      { followup_id: "adopted", source_session_id: "adopted_source", adoption_status: "accepted", observed_outcome: "improved", perceived_outcome: "pending", observed_outcome_note: "前次采用后的对照" },
    ] as never);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "行动" }));
    await user.click(await screen.findByText("查看原记录与对照依据", { selector: "summary" }));
    expect(await screen.findByText("前次采用后的对照")).toBeVisible();
    expect(screen.getByLabelText("查看哪次建议")).toHaveValue("adopted");
    await user.selectOptions(screen.getByLabelText("查看哪次建议"), "new");
    expect(screen.getByRole("heading", { name: "等下一次可靠记录自动回看" })).toBeVisible();
    expect(screen.queryByText("前次采用后的对照")).not.toBeInTheDocument();
  });

  it("prevents duplicate saves in the health followup panel", async () => {
    mocked.updateActionFollowup.mockClear();
    mocked.actionFollowups.mockResolvedValue([{
      followup_id: "health_followup", member_id: "m_001", source_session_id: "old",
      adoption_status: "suggested", perceived_outcome: "pending", observed_outcome: "pending",
    }] as never);
    let rejectSave!: (reason: Error) => void;
    mocked.updateActionFollowup.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "行动" }));
    const accept = await screen.findByRole("button", { name: "我会试试" });
    await user.click(accept);
    expect(accept).toBeDisabled();
    await user.click(accept);
    expect(mocked.updateActionFollowup).toHaveBeenCalledTimes(1);
    await act(async () => rejectSave(new Error("offline")));
    expect(accept).toBeEnabled();
    expect(screen.queryByText("已保存意向")).not.toBeInTheDocument();
  });

  it("reloads current outcomes after feedback save instead of keeping the write snapshot", async () => {
    const plan = { followup_id: "saved", member_id: "m_001", adoption_status: "suggested", observed_outcome: "pending", perceived_outcome: "pending" };
    mocked.actionFollowups.mockResolvedValue([plan] as never);
    let finishSave!: (value: never) => void;
    mocked.updateActionFollowup.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "行动" }));
    await user.click(await screen.findByRole("button", { name: "我会试试" }));
    mocked.actionFollowups.mockResolvedValue([{ ...plan, adoption_status: "accepted", observed_outcome: "same", observed_outcome_note: "保存期间新到的对照" }] as never);
    await act(async () => finishSave({ ...plan, adoption_status: "accepted" } as never));
    await user.click(screen.getByText("查看原记录与对照依据", { selector: "summary" }));
    expect(await screen.findByText("保存期间新到的对照")).toBeVisible();
    expect(screen.getByText("已保存意向")).toBeInTheDocument();
  });

  it("retries loading followup without submitting feedback", async () => {
    mocked.updateActionFollowup.mockClear();
    mocked.actionFollowups.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "行动" }));
    const retry = await screen.findByRole("button", { name: "重试加载跟进" });
    mocked.actionFollowups.mockResolvedValue([{ followup_id: "retry", adoption_status: "accepted", observed_outcome: "same", observed_outcome_note: "跟进加载已恢复" }] as never);
    await user.click(retry);
    await user.click(await screen.findByText("查看原记录与对照依据", { selector: "summary" }));
    expect(await screen.findByText("跟进加载已恢复")).toBeVisible();
    expect(mocked.updateActionFollowup).not.toHaveBeenCalled();
  });

  it("still loads authorized member data when viewer cannot manage the claim inbox", async () => {
    mocked.inbox.mockRejectedValue(new ApiError(403, "HOUSEHOLD_ROLE_DENIED"));
    render(<App />);
    await waitFor(() => expect(mocked.members).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /了解如何开始/ }),
    ).toBeInTheDocument();
  });

  it.each(["home", "health"] as const)("retries an initial record load failure from %s without claiming there are no records", async (page) => {
    mocked.sessions.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "记录暂时没接回来" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /了解如何开始/ })).not.toBeInTheDocument();
    if (page === "health") {
      await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
      expect(screen.getByRole("region", { name: "最近记录" })).toHaveTextContent("暂未读到");
    }
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法读取记录。");
    expect(screen.queryByText("还没有已认领记录。")).not.toBeInTheDocument();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    mocked.sessions.mockResolvedValue([{
      session_id: "recovered_record", occurred_at: "2026-09-09T08:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "重新接回的旧观察",
    }]);
    await user.click(screen.getByRole("button", { name: "重试读取记录" }));
    if (page === "home") {
      expect(await screen.findByRole("button", { name: "看看这次结果 →" })).toBeVisible();
      expect(screen.getByText("重新接回的旧观察")).toBeVisible();
    } else {
      expect(await within(screen.getByRole("region", { name: "最近记录" })).findByText("重新接回的旧观察")).toBeVisible();
    }
    expect(mocked.sessions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "收到，这次交给我。" })).not.toBeInTheDocument();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it("shows available records while the separate trend request is still pending", async () => {
    mocked.trend.mockImplementation(() => new Promise(() => {}));
    mocked.sessions.mockResolvedValue([{
      session_id: "available_without_trend", occurred_at: "2026-09-09T08:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "趋势还在加载时已到达的观察",
    }]);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("button", { name: "看看这次结果 →" })).toBeEnabled();
    expect(mocked.trend).toHaveBeenCalledWith(expect.anything(), "m_001", 30);
    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    const records = screen.getByRole("region", { name: "最近记录" });
    expect(within(records).getByText("趋势还在加载时已到达的观察")).toBeVisible();
    expect(within(records).getByRole("button", { name: "查看这条报告 →" })).toBeEnabled();
    expect(within(records).queryByText("还没有已认领记录。")).not.toBeInTheDocument();
  });

  it("opens Agent Doctor and performs safety triage", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: /了解如何开始/ }),
    );
    expect(
      screen.getByRole("heading", { name: "聊聊你的记录" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "需要警惕什么" }));
    expect(await screen.findByText(/立即寻求急诊帮助/)).toBeInTheDocument();
    expect(mocked.agentChat).toHaveBeenCalledWith(
      expect.anything(),
      "m_001",
      "出现血便怎么办",
      undefined,
    );
    await user.click(screen.getByRole("button", { name: "有帮助" }));
    expect(mocked.rateAgentMessage).toHaveBeenCalledWith(expect.anything(), 2, "helpful");
  });

  it("turns the latest result into a structured analysis task", async () => {
    mocked.agentChat.mockClear();
    mocked.sessions.mockResolvedValue([
      {
        session_id: "ses_latest",
        occurred_at: "2026-08-29T12:30:00Z",
        assignment_version: 1,
        assessment_status: "assessed",
        risk_level: "normal",
        message: "本次信号接近你的个人基线。",
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    expect(mocked.agentChat).not.toHaveBeenCalled();
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledTimes(1));
    expect(mocked.analyzeSession).toHaveBeenCalledWith(
      expect.anything(), "m_001", "ses_latest", undefined,
    );
    expect(await screen.findByRole("heading", { name: /继续保持稳定节奏/ })).toBeInTheDocument();
    expect(screen.getByLabelText("多方面建议")).toHaveTextContent("补水");
    expect(screen.getByText("饮食", { selector: ".more-advice b" })).not.toBeVisible();
    await user.click(screen.getByText("其他可选建议（3）"));
    expect(screen.getByText("饮食", { selector: ".more-advice b" })).toBeVisible();
    expect(screen.getByText("活动", { selector: ".more-advice b" })).toBeVisible();
  });

  it("opens the selected historical record rather than analyzing the newest record", async () => {
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "older");
    mocked.analyzeSession.mockClear();
    mocked.analyzeSession.mockResolvedValue({ ...result, report: { ...result.report!, session_id: "older" } });
    mocked.sessions.mockResolvedValue([
      { session_id: "newer", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "最新观察" },
      { session_id: "older", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "之前的观察" },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "看看这次结果 →" });
    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    await user.click(within(screen.getByRole("region", { name: "最近记录" })).getAllByRole("button", { name: "查看这条报告 →" })[1]);
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledWith(expect.anything(), "m_001", "older", undefined));
    expect(document.querySelector(".report-record-context")).toHaveTextContent("8月29日");
    expect(screen.queryByText("新的身体信号已到达")).not.toBeInTheDocument();
  });

  it("returns from an older report to the same record section with earlier history still expanded", async () => {
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "record_3");
    mocked.analyzeSession.mockClear();
    mocked.analyzeSession.mockResolvedValue({ ...result, report: { ...result.report!, session_id: "record_3", headline: "更早记录的报告" } });
    mocked.sessions.mockResolvedValue([1, 2, 3].map(index => ({
      session_id: `record_${index}`, occurred_at: `2026-09-0${9 - index}T08:00:00Z`,
      assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: `第${index}条观察`,
    })));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "看看这次结果 →" });
    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    const recordSection = screen.getByRole("region", { name: "最近记录" });
    const historyToggle = within(recordSection).getByText("查看更早的 1 条记录");
    await user.click(historyToggle);
    const earlierHistory = historyToggle.closest("details")!;
    expect(earlierHistory).toHaveAttribute("open");
    await user.click(within(earlierHistory).getByRole("button", { name: "查看这条报告 →" }));
    expect(await screen.findByRole("heading", { name: "更早记录的报告" })).toBeVisible();
    expect(mocked.analyzeSession).toHaveBeenCalledWith(expect.anything(), "m_001", "record_3", undefined);
    expect(screen.queryByRole("region", { name: "最近记录" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    expect(await screen.findByRole("region", { name: "最近记录" })).toBe(recordSection);
    expect(screen.getByRole("button", { name: /^记录/ })).toHaveAttribute("aria-pressed", "true");
    expect(earlierHistory).toHaveAttribute("open");
    expect(within(earlierHistory).getByRole("button", { name: "查看这条报告 →" })).toBeVisible();
  });

  it("opens action history for the report source rather than the newest adopted suggestion", async () => {
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "source_record");
    mocked.analyzeSession.mockClear();
    mocked.analyzeSession.mockResolvedValue({ ...result, report: { ...result.report!, session_id: "source_record", followup_id: "source_plan", headline: "源记录的报告" } });
    mocked.sessions.mockResolvedValue([
      { session_id: "newest_record", occurred_at: "2026-09-08T08:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "最新一条观察" },
      { session_id: "source_record", occurred_at: "2026-09-07T08:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "需要接着回看的源观察" },
    ]);
    mocked.actionFollowups.mockResolvedValue([
      { followup_id: "newest_plan", member_id: "m_001", source_session_id: "newest_record", adoption_status: "accepted", observed_outcome: "pending", perceived_outcome: "pending", observed_outcome_note: "新建议的对照" },
      { followup_id: "source_plan", member_id: "m_001", source_session_id: "source_record", adoption_status: "accepted", observed_outcome: "same", perceived_outcome: "pending", observed_outcome_note: "当前报告来源的对照" },
    ] as never);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "看看这次结果 →" });
    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    const records = screen.getByRole("region", { name: "最近记录" });
    await user.click(within(records).getAllByRole("button", { name: "查看这条报告 →" })[1]);
    expect(await screen.findByRole("heading", { name: "源记录的报告" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "查看行动记录 →" }));
    expect(screen.getByRole("button", { name: "行动" })).toHaveAttribute("aria-pressed", "true");
    const actions = screen.getByRole("article", { name: "行动回看" });
    expect(within(actions).getByLabelText("查看哪次建议")).toHaveValue("source_plan");
    await user.click(within(actions).getByText("查看原记录与对照依据", { selector: "summary" }));
    expect(within(actions).getByText("当前报告来源的对照")).toBeVisible();
    expect(within(actions).queryByText("新建议的对照")).not.toBeInTheDocument();
    await user.click(within(actions).getByRole("button", { name: "重看这条报告 →" }));
    expect(await screen.findByRole("heading", { name: "源记录的报告" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await screen.findByRole("article", { name: "行动回看" });
    expect(screen.getByRole("button", { name: "行动" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("article", { name: "行动回看" })).getByLabelText("查看哪次建议")).toHaveValue("source_plan");
    await user.selectOptions(within(screen.getByRole("article", { name: "行动回看" })).getByLabelText("查看哪次建议"), "newest_plan");
    expect(within(screen.getByRole("article", { name: "行动回看" })).getByText("新建议的对照")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^记录/ }));
    await user.click(within(screen.getByRole("region", { name: "最近记录" })).getAllByRole("button", { name: "查看这条报告 →" })[1]);
    expect(await screen.findByRole("heading", { name: "源记录的报告" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "查看行动记录 →" }));
    const returnedActions = screen.getByRole("article", { name: "行动回看" });
    expect(within(returnedActions).getByLabelText("查看哪次建议")).toHaveValue("source_plan");
    expect(within(returnedActions).getByText("当前报告来源的对照")).toBeVisible();
    expect(within(returnedActions).queryByText("新建议的对照")).not.toBeInTheDocument();
  });

  it("keeps a successful report when optional run details fail", async () => {
    mocked.analyzeSession.mockClear();
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z",
      assignment_version: 1, assessment_status: "assessed", risk_level: "normal",
      message: "本次检测已完成。",
    }]);
    mocked.agentRun.mockRejectedValueOnce(new Error("Network unavailable"));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    expect(await screen.findByRole("heading", { name: /继续保持稳定节奏/ })).toBeInTheDocument();
    expect(await screen.findByText(/回复已生成，部分跟进信息暂时未加载/)).toBeInTheDocument();
    expect(screen.getByLabelText("多方面建议")).toHaveTextContent("补水");
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"] as const)("keeps the report and saved choice through a plain follow-up with late run details %s", async (detailsOutcome) => {
    const response = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockResolvedValue({ ...response, report: { ...response.report!, followup_id: "saved_plan" } });
    mocked.analyzeSession.mockClear();
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z",
      assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "本次检测已完成。",
    }]);
    mocked.updateActionFollowup.mockResolvedValueOnce({ followup_id: "saved_plan", adoption_status: "accepted" } as never);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    await user.click(await screen.findByRole("button", { name: "今天会试试" }));
    expect(await screen.findByText(/已保存你的意向/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "看看最近趋势" })).toBeEnabled());
    const report = screen.getByRole("heading", { name: /继续保持稳定节奏/ });
    const choice = screen.getByRole("button", { name: "今天会试试" });
    const followupReads = mocked.actionFollowups.mock.calls.length;
    const run = await mocked.agentRun.getMockImplementation()!(null as never, "run_question");
    let finishChat!: (value: typeof response) => void;
    let finishDetails!: (value: typeof run) => void;
    let failDetails!: (reason: Error) => void;
    mocked.agentChat.mockImplementationOnce(() => new Promise(resolve => { finishChat = resolve; }));
    mocked.agentRun.mockImplementationOnce(() => new Promise((resolve, reject) => { finishDetails = resolve; failDetails = reject; }));
    await user.type(screen.getByLabelText("描述你的情况"), "这条建议该怎么理解？");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(screen.getByRole("button", { name: "等待回答" })).toBeDisabled();
    expect(report).toBeVisible();
    expect(choice).toHaveAttribute("aria-pressed", "true");

    await act(async () => { finishChat({
      ...response, report: null, run_id: "run_question",
      message: { ...response.message, message_id: 29, content: "可以从报告里的第一项生活建议开始理解。" },
    }); });
    expect(screen.getByText("可以从报告里的第一项生活建议开始理解。")).toBeVisible();
    expect(report).toBeVisible();
    expect(choice).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("新的身体信号已到达")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("描述你的情况"), "接着问");
    expect(screen.getByRole("button", { name: "发送 →" })).toBeEnabled();

    await act(async () => {
      if (detailsOutcome === "success") finishDetails(run);
      else failDetails(new ApiError(404, "AGENT_RUN_NOT_FOUND"));
    });
    expect(report).toBeVisible();
    expect(choice).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/已保存你的意向/)).toBeVisible();
    expect(screen.getByRole("button", { name: "查看行动记录 →" })).toBeVisible();
    expect(screen.getByText("可以从报告里的第一项生活建议开始理解。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "立即自动分析 →" })).not.toBeInTheDocument();
    expect(mocked.actionFollowups).toHaveBeenCalledTimes(followupReads);
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    expect(mocked.agentChat).toHaveBeenCalledWith(expect.anything(), "m_001", "这条建议该怎么理解？", "conv_analysis");
    if (detailsOutcome === "failure") expect(screen.getByText(/回复已生成，部分跟进信息暂时未加载/)).toBeVisible();
    else expect(screen.queryByText(/回复已生成，部分跟进信息暂时未加载/)).not.toBeInTheDocument();
  });

  it("clears an older report on failed new analysis and retries the same record", async () => {
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockClear();
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z",
      assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "新记录已收到",
    }]);
    mocked.conversations.mockResolvedValue([{ conversation_id: "old_conversation" }] as never);
    mocked.conversation.mockResolvedValue({ conversation_id: "old_conversation", messages: [{
      message_id: 1, role: "assistant", content: "历史对话", metadata: {
        report: { ...result.report!, session_id: "old_record", headline: "这是旧报告不是本次结果" },
      },
    }] } as never);
    mocked.analyzeSession.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    const retry = await screen.findByRole("button", { name: "重新生成本次报告" });
    expect(screen.queryByRole("heading", { name: "这是旧报告不是本次结果" })).not.toBeInTheDocument();
    expect(screen.getByText("本次报告暂未完成，请重试")).toBeInTheDocument();
    expect(document.querySelectorAll(".analysis-live-steps .done")).toHaveLength(1);
    await user.click(retry);
    expect(await screen.findByRole("heading", { name: /继续保持稳定节奏/ })).toBeInTheDocument();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(2);
    expect(mocked.analyzeSession).toHaveBeenLastCalledWith(expect.anything(), "m_001", "ses_latest", "old_conversation");
    expect(screen.queryByText("本次报告暂未完成，请重试")).not.toBeInTheDocument();
  });

  it.each([
    ["insufficient", false, "本次信息不足，等待可靠数据", "等待可靠数据"],
    ["urgent", true, "安全提醒已生成，请优先查看", "优先处理"],
  ] as const)("labels %s reports without claiming routine advice completion", async (status, reliable, title, stamp) => {
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockResolvedValue({ ...result, report: { ...result.report!, status, reliable } });
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z",
      assignment_version: 1, assessment_status: "assessed", risk_level: status === "urgent" ? "redline" : "unknown", message: "模拟信号",
    }]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(document.querySelector(".report-stamp")).toHaveTextContent(stamp);
    expect(screen.queryByRole("button", { name: "今天会试试" })).not.toBeInTheDocument();
    expect(screen.queryByText("本次分析与行动建议已完成")).not.toBeInTheDocument();
  });

  it("restores conversation even when followup initialization fails", async () => {
    mocked.actionFollowups.mockRejectedValueOnce(new Error("offline"));
    mocked.conversations.mockResolvedValue([{ conversation_id: "history_1" }] as never);
    mocked.conversation.mockResolvedValue({ conversation_id: "history_1", messages: [{
      message_id: 55, role: "assistant", content: "此前保存的对话仍然在这里", metadata: {},
    }] } as never);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /了解如何开始/ }));
    expect(await screen.findByText("查看此前对话（1 条）")).toBeInTheDocument();
    expect(screen.queryByText("此前保存的对话仍然在这里")).not.toBeInTheDocument();
    expect(screen.getByText(/部分状态或跟进信息暂时未加载/)).toBeInTheDocument();
    const history = document.querySelector("details.conversation-history")!;
    expect(history).not.toHaveAttribute("open");
    await user.click(screen.getByText("查看此前对话（1 条）"));
    expect(history).toHaveAttribute("open");
    expect(await screen.findByText("此前保存的对话仍然在这里")).toBeVisible();
    expect(screen.getByText(/不代表本次检测结果/)).toBeVisible();
    await user.click(screen.getByText("查看此前对话（1 条）"));
    await user.type(screen.getByLabelText("描述你的情况"), "继续看看本次记录");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送 →" })).toBeDisabled());
    expect(screen.getByText("继续看看本次记录").closest("details")).toBeNull();
    expect(history).not.toHaveAttribute("open");
  });

  it.each(["success", "failure"] as const)("preserves a draft while history loads with %s", async (outcome) => {
    mocked.agentChat.mockClear();
    mocked.conversations.mockResolvedValue([{ conversation_id: "slow_history" }] as never);
    let complete!: (value: never) => void;
    let fail!: (reason: Error) => void;
    mocked.conversation.mockImplementationOnce(() => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /了解如何开始/ }));
    const input = await screen.findByLabelText("描述你的情况");
    await user.type(input, "我先写下这个问题");
    expect(screen.getByRole("button", { name: "发送 →" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "看看最近趋势" })).toBeEnabled();
    expect(mocked.agentChat).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "success") complete({ conversation_id: "slow_history", messages: [] } as never);
      else fail(new Error("offline"));
    });
    expect(input).toHaveValue("我先写下这个问题");
    await user.click(await screen.findByRole("button", { name: "发送 →" }));
    await waitFor(() => expect(mocked.agentChat).toHaveBeenCalledTimes(1));
    expect(mocked.agentChat).toHaveBeenCalledWith(expect.anything(), "m_001", "我先写下这个问题", outcome === "success" ? "slow_history" : undefined);
  });

  it("does not wait for optional status or followups before opening history", async () => {
    mocked.agentStatus.mockImplementationOnce(() => new Promise(() => {}));
    mocked.actionFollowups.mockImplementationOnce(() => new Promise(() => {}));
    mocked.conversations.mockResolvedValue([{ conversation_id: "available_history" }] as never);
    mocked.conversation.mockResolvedValue({ conversation_id: "available_history", messages: [
      { message_id: 99, role: "assistant", content: "历史已就绪，不必等辅助查询", metadata: {} },
    ] } as never);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /了解如何开始/ }));
    await user.click(await screen.findByText("查看此前对话（1 条）"));
    expect(await screen.findByText("历史已就绪，不必等辅助查询")).toBeInTheDocument();
    await user.type(screen.getByLabelText("描述你的情况"), "新的问题");
    expect(screen.getByRole("button", { name: "发送 →" })).toBeEnabled();
    expect(screen.queryByText(/正在接回此前对话/)).not.toBeInTheDocument();
  });

  it("does not let late historical followups restore an obsolete report", async () => {
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    let finishFollowups!: (items: never[]) => void;
    mocked.actionFollowups.mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise((resolve) => { finishFollowups = resolve; }));
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "当前记录",
    }]);
    mocked.conversations.mockResolvedValue([{ conversation_id: "old_history" }] as never);
    mocked.conversation.mockResolvedValue({ conversation_id: "old_history", messages: [{
      message_id: 88, role: "assistant", content: "旧正文", metadata: {
        report: { ...result.report!, session_id: "old_session", headline: "不该恢复的旧报告" },
      },
    }] } as never);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    expect(await screen.findByRole("heading", { name: /继续保持稳定节奏/ })).toBeInTheDocument();
    await act(async () => finishFollowups([]));
    expect(screen.queryByRole("heading", { name: "不该恢复的旧报告" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /继续保持稳定节奏/ })).toBeInTheDocument();
  });

  it("locks feedback while saving and allows retry after failure", async () => {
    mocked.updateActionFollowup.mockClear();
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockResolvedValue({ ...result, report: { ...result.report!, followup_id: "f_1" } });
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "本次检测已完成。",
    }]);
    let rejectSave!: (reason: Error) => void;
    mocked.updateActionFollowup.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    const accept = await screen.findByRole("button", { name: "今天会试试" });
    await user.click(accept);
    expect(accept).toBeDisabled();
    expect(screen.getByRole("button", { name: "暂不采用" })).toBeDisabled();
    await user.click(accept);
    expect(mocked.updateActionFollowup).toHaveBeenCalledTimes(1);
    await act(async () => rejectSave(new Error("offline")));
    expect(accept).toBeEnabled();
    expect(accept).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("alert")).toHaveTextContent("选择尚未确认保存");
    expect(screen.queryByText(/已保存你的意向/)).not.toBeInTheDocument();
  });

  it("keeps saved feedback when an earlier details query returns late", async () => {
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockResolvedValue({ ...result, report: { ...result.report!, followup_id: "f_1" } });
    mocked.sessions.mockResolvedValue([{
      session_id: "ses_latest", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "本次检测已完成。",
    }]);
    let finishDetails!: (value: never) => void;
    mocked.actionFollowups.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise(resolve => { finishDetails = resolve; }));
    mocked.updateActionFollowup.mockResolvedValueOnce({ followup_id: "f_1", adoption_status: "accepted" } as never);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    const accept = await screen.findByRole("button", { name: "今天会试试" });
    expect(screen.queryByText("正在生成完整分析报告…")).not.toBeInTheDocument();
    expect(document.querySelector(".report-evidence")).not.toHaveAttribute("open");
    await user.click(accept);
    expect(await screen.findByText(/已保存你的意向/)).toBeInTheDocument();
    await act(async () => finishDetails([{ followup_id: "f_1", adoption_status: "suggested" }] as never));
    expect(accept).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "查看行动记录 →" })).toBeInTheDocument();
  });

  it("clears the home result immediately when switching to a member with delayed records", async () => {
    mocked.sessions.mockImplementation(async (_config, member) => member === "m_001" ? [{
      session_id: "old", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "仅属于小风的观察",
    }] : new Promise(() => {}));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("仅属于小风的观察");
    await user.selectOptions(screen.getByLabelText("首页查看哪位成员"), "m_002");
    expect(screen.queryByText("仅属于小风的观察")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "看看这次结果 →" })).not.toBeInTheDocument();
  });

  it.each(["2026-09-08T08:00:00", "2026-09-08T08:00:00Z"])("restores a saved choice with UTC timestamp %s after returning and reloading", async (updatedAt) => {
    const saved = { followup_id: "diary_f", member_id: "m_001", source_session_id: "ses_latest", adoption_status: "accepted", updated_at: updatedAt } as const;
    const result = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockResolvedValue({ ...result, report: { ...result.report!, followup_id: saved.followup_id } });
    mocked.sessions.mockResolvedValue([{ session_id: "ses_latest", occurred_at: "2026-09-08T07:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "日记中的观察" }]);
    mocked.updateActionFollowup.mockImplementationOnce(async () => {
      mocked.actionFollowups.mockResolvedValue([saved] as never);
      return saved as never;
    });
    const user = userEvent.setup();
    const first = render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    await user.click(await screen.findByRole("button", { name: "今天会试试" }));
    await screen.findByText(/已保存你的意向/);
    expect(document.querySelector(".choice-saved-time")).toHaveAttribute("datetime", "2026-09-08T08:00:00.000Z");
    expect(document.querySelector(".choice-saved-time")).toHaveTextContent(new Date("2026-09-08T08:00:00Z").toLocaleString("zh-CN"));
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await screen.findByRole("heading", { name: "小风 的便便日记" });
    expect(await screen.findByText("✓ 已记下：准备试试")).toBeVisible();
    first.unmount();
    render(<App />);
    expect(await screen.findByText("✓ 已记下：准备试试")).toBeInTheDocument();
  });

  it("does not show another member's delayed saved choice on the home scene", async () => {
    mocked.sessions.mockImplementation(async (_config, memberId) => [{ session_id: `record_${memberId}`, occurred_at: "2026-09-08T07:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: `记录属于${memberId}` }]);
    let finish!: (value: never) => void;
    mocked.actionFollowups.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("记录属于m_001");
    await user.selectOptions(screen.getByLabelText("首页查看哪位成员"), "m_002");
    await screen.findByText("记录属于m_002");
    await act(async () => finish([{ member_id: "m_001", source_session_id: "record_m_001", adoption_status: "accepted" }] as never));
    expect(screen.queryByText("✓ 已记下：准备试试")).not.toBeInTheDocument();
  });

  it("maps a reliable hard sensor result to the scattered cartoon", async () => {
    mocked.sessions.mockResolvedValue([
      {
        session_id: "ses_dry",
        occurred_at: "2026-08-29T12:30:00Z",
        assignment_version: 1,
        assessment_status: "assessed",
        risk_level: "normal",
        message: "检测到便便呈一颗颗、偏干硬形态",
        visual_profile: {
          mapping_version: "poop-visual-v1",
          variant: "scattered",
          reliable: true,
          shape: { value: "hard", confidence: 0.91, source: "sensor", model_version: "shape-0.1" },
          color: { value: "brown", confidence: 0.88, source: "sensor", model_version: "color-0.2" },
          odor: { value: "moderate", confidence: 0.84, source: "sensor", model_version: "odor-0.1" },
        },
      },
    ]);

    render(<App />);
    const character = await screen.findByAltText("传感器映射的便便卡通形象：分散颗粒");
    expect(character).toHaveAttribute("src", "/poop-shape-scattered-yellow-v2.webp");
    expect(character).toHaveAttribute("data-visual-variant", "scattered");
    expect(screen.getByText("最近一次记录 · 小风")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "有点干，照顾一下自己" })).toBeInTheDocument();
  });

  it("plays a new-result moment and then automatically asks Agent Doctor once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocked.analyzeSession.mockClear();
    mocked.analyzeSession.mockResolvedValueOnce({
      conversation_id: "conv_dry",
      message: {
        message_id: 8, role: "assistant",
        content: "这次形态偏干硬，今天可以分次补充水分，并观察下一次的变化。",
        created_at: "2026-08-30T00:00:00Z",
      },
      decision: "health_education",
      allowed_actions: ["explain", "ask_follow_up", "offer_water_pickup"],
      authorization_basis: "household_owner", policy_version: "safety-v1",
      model_version: "test-model", delegated_agent: "health_doctor",
      skill: "comprehensive_review", run_id: "run_dry", skill_version: "1.0.0",
      report: {
        session_id: "ses_from_hardware", generated_at: "2026-08-30T00:00:00Z",
        status: "ready", reliable: true,
        headline: "这次有点偏干，今天先把节奏调柔和",
        summary: "检测到便便呈一颗颗、偏干硬形态",
        findings: [
          { dimension: "shape", label: "形状", value: "一颗颗、偏干硬", confidence: 0.92, source: "sensor" },
        ],
        recommendations: [
          { category: "hydration", title: "补水", guidance: "今天分次、少量补充水分。", timing: "today" },
          { category: "diet", title: "饮食", guidance: "循序增加含纤维食物。", timing: "today" },
          { category: "movement", title: "活动", guidance: "安排轻松走动。", timing: "today" },
          { category: "observation", title: "继续观察", guidance: "留意下一次变化。", timing: "next_time" },
        ],
        next_step: "记录今天是否采用建议，我会结合下一次可靠记录跟进变化。",
      },
    });
    mocked.sessions
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          session_id: "ses_from_hardware",
          occurred_at: "2026-08-29T13:00:00Z",
          assignment_version: 1,
          assessment_status: "assessed",
          risk_level: "normal",
          message: "检测到便便呈一颗颗、偏干硬形态",
        },
      ]);
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(await screen.findByRole("heading", { name: "收到，这次交给我。" })).toBeInTheDocument();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledTimes(1));
    expect(mocked.analyzeSession).toHaveBeenCalledWith(
      expect.anything(), "m_001", "ses_from_hardware", undefined,
    );
    expect(await screen.findByRole("heading", { name: "一颗颗、偏干硬" })).toBeInTheDocument();
    expect(screen.getByLabelText("自动分析进度")).toHaveTextContent("数据质量已检查");
    expect(screen.getByText(/未经真人医生审核/)).toBeInTheDocument();
    expect(screen.queryByText("✓ 健康医生已复核")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "准备取水" })).not.toBeInTheDocument();
    expect(screen.queryByText("让机械臂帮你取一杯水？")).not.toBeInTheDocument();
    expect(mocked.pickupWater).not.toHaveBeenCalled();
    expect(mocked.robotTask).not.toHaveBeenCalled();
    mocked.sessions.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    mocked.sessions.mockResolvedValue([{ session_id: "ses_from_hardware", occurred_at: "2026-08-29T13:00:00Z",
      assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "恢复原记录" }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole("heading", { name: "收到，这次交给我。" })).not.toBeInTheDocument();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["健康", "小风 的记录册"],
    ["广场", "便便岛"],
    ["我的", "小风 的小窝"],
  ])("keeps %s open when polling receives a record until the user chooses to view it", async (navigation, heading) => {
    const response = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "polled_record");
    mocked.analyzeSession.mockClear();
    mocked.analyzeSession.mockResolvedValue({ ...response, report: { ...response.report!, session_id: "polled_record", headline: "主动打开的新记录报告" } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: new RegExp(`${navigation}$`) })[0]);
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    const focusedBeforeArrival = document.activeElement;
    mocked.sessions.mockResolvedValue([{
      session_id: "polled_record", occurred_at: "2026-09-10T08:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "轮询接回的新观察", simulated: true,
    }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const notice = await screen.findByRole("complementary", { name: "新记录提醒" });
    expect(notice).toHaveTextContent("小风");
    expect(notice).toHaveTextContent("模拟记录");
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    expect(document.activeElement).toBe(focusedBeforeArrival);
    expect(screen.queryByRole("heading", { name: "收到，这次交给我。" })).not.toBeInTheDocument();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    const pushHistory = vi.spyOn(window.history, "pushState");
    await user.click(within(notice).getByRole("button", { name: "查看新记录" }));
    expect(await screen.findByRole("heading", { name: "收到，这次交给我。" })).toBeVisible();
    expect(pushHistory).toHaveBeenCalledTimes(1);
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    expect(await screen.findByRole("heading", { name: "主动打开的新记录报告" })).toBeVisible();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    expect(mocked.analyzeSession).toHaveBeenCalledWith(expect.anything(), "m_001", "polled_record", undefined);
    expect(pushHistory).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/report?member=m_001&record=polled_record");
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看新记录" })).not.toBeInTheDocument();
  });

  it.each(["normal", "redline"] as const)("keeps direct chat, its reply and draft when polling receives a %s record", async riskLevel => {
    window.history.replaceState(null, "", "/#/chat?member=m_001");
    const response = await mocked.agentChat.getMockImplementation()!(null as never, "m_001", "fixture");
    mocked.agentChat.mockResolvedValue({ ...response, model_version: "deepseek-v4-pro", message: { ...response.message, content: "已经生成的完整回答。", model_version: "deepseek-v4-pro" } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await user.type(await screen.findByLabelText("描述你的情况"), "现在的问题");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    expect(await screen.findByText("已经生成的完整回答。")).toBeVisible();
    await user.type(screen.getByLabelText("描述你的情况"), "正在编辑的下一条草稿");
    const focused = document.activeElement;
    mocked.sessions.mockResolvedValue([{ session_id: "direct_chat_new", occurred_at: "2026-09-13T00:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: riskLevel, message: "刚收到的记录。", simulated: true }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const notice = await screen.findByRole("complementary", { name: "新记录提醒" });
    expect(window.location.hash).toBe("#/chat?member=m_001");
    expect(screen.getByRole("heading", { name: "聊聊你的记录" })).toBeVisible();
    expect(screen.getByText("已经生成的完整回答。")).toBeVisible();
    expect(screen.getByText("本次模型：deepseek-v4-pro")).toBeVisible();
    expect(screen.getByLabelText("描述你的情况")).toHaveValue("正在编辑的下一条草稿");
    expect(document.activeElement).toBe(focused);
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    expect(mocked.agentChat).toHaveBeenCalledTimes(1);
    expect(within(notice).getByRole(riskLevel === "redline" ? "alert" : "status")).toBeVisible();
    await user.click(within(notice).getByRole("button", { name: "查看新记录" }));
    expect(window.location.hash).toBe("#/report?member=m_001&record=direct_chat_new");
    expect(await screen.findByRole("heading", { name: "收到，这次交给我。" })).toBeVisible();
  });

  it("keeps an urgent queued record ahead of a later normal record until each is dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /我的$/ })[0]);
    expect(await screen.findByRole("heading", { name: "小风 的小窝" })).toBeVisible();
    const urgentRecord = {
      session_id: "queued_urgent", occurred_at: "2026-09-10T08:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "redline", message: "需要优先查看的记录", simulated: true,
    };
    mocked.sessions.mockResolvedValue([urgentRecord]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    let notice = screen.getByRole("complementary", { name: "新记录提醒" });
    expect(within(notice).getByRole("alert")).toHaveTextContent("新记录需要优先查看");
    expect(within(notice).getByText("1 条待查看")).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: /首页$/ })[0]);
    expect(screen.getByRole("heading", { name: "小风 的便便日记" })).toBeVisible();
    mocked.sessions.mockResolvedValue([{
      ...urgentRecord, session_id: "queued_normal", occurred_at: "2026-09-10T08:01:00Z",
      risk_level: "normal", message: "之后到达的普通记录",
    }, urgentRecord]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    notice = screen.getByRole("complementary", { name: "新记录提醒" });
    expect(within(notice).getByRole("alert")).toHaveTextContent("请查看这次记录的安全提醒");
    expect(within(notice).getByText("2 条待查看")).toBeVisible();
    expect(within(notice).queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "小风 的便便日记" })).toBeVisible();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    await user.click(within(notice).getByRole("button", { name: "稍后查看，关闭新记录提醒" }));
    const nextNotice = screen.getByRole("complementary", { name: "新记录提醒" });
    expect(within(nextNotice).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(nextNotice).getByRole("status")).toHaveTextContent("有一条新记录，等你来看");
    expect(within(nextNotice).getByText("1 条待查看")).toBeVisible();
    expect(within(nextNotice).getByRole("button", { name: "查看新记录" })).toBeVisible();
    await user.click(within(nextNotice).getByRole("button", { name: "稍后查看，关闭新记录提醒" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole("complementary", { name: "新记录提醒" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "小风 的便便日记" })).toBeVisible();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it("removes a queued record when it is no longer available to the current member", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    mocked.sessions.mockResolvedValue([{
      session_id: "withdrawn_pending", occurred_at: "2026-09-10T08:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "等待查看的旧归属记录",
    }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole("button", { name: "查看新记录" })).toBeVisible();
    mocked.sessions.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole("button", { name: "查看新记录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "新记录提醒" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "最近记录" })).queryByText("等待查看的旧归属记录")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "小风 的记录册" })).toBeVisible();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)("keeps the newest sensor report after an older request finishes with %s", async (outcome) => {
    const response = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "ses_latest");
    mocked.analyzeSession.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const oldRecord = {
      session_id: "slow_old", occurred_at: "2026-08-29T12:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "之前的记录",
    };
    mocked.sessions.mockResolvedValue([oldRecord]);
    let resolveOld!: (value: typeof response) => void;
    let rejectOld!: (error: Error) => void;
    mocked.analyzeSession.mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveOld = resolve; rejectOld = reject;
    })).mockResolvedValueOnce({ ...response, report: { ...response.report!, session_id: "fresh_new", headline: "最新记录的专属报告" } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledTimes(1));
    mocked.sessions.mockResolvedValue([{ ...oldRecord, session_id: "fresh_new", occurred_at: "2026-08-29T13:00:00Z" }, oldRecord]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByRole("heading", { name: "收到，这次交给我。" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    expect(await screen.findByRole("heading", { name: "最新记录的专属报告" })).toBeInTheDocument();
    await act(async () => {
      if (outcome === "success") resolveOld({ ...response, report: { ...response.report!, session_id: "slow_old", headline: "迟到的旧报告" } });
      else rejectOld(new Error("late failure"));
    });
    expect(screen.getByRole("heading", { name: "最新记录的专属报告" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "迟到的旧报告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新生成本次报告" })).not.toBeInTheDocument();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(2);
    expect(mocked.analyzeSession).toHaveBeenLastCalledWith(expect.anything(), "m_001", "fresh_new", undefined);
  });

  it("saves the structured health profile through the versioned profile API", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "趋势" }));
    await user.click(screen.getByText("让 Agent 更懂你", { selector: "summary b" }));
    const diet = await screen.findByPlaceholderText("例如：常吃辣，蔬菜较少");
    await user.type(diet, "蔬菜较少");
    await user.click(screen.getByRole("button", { name: "保存健康档案" }));
    expect(mocked.updateHealthProfile).toHaveBeenCalledWith(
      expect.anything(), "m_001", expect.objectContaining({ diet_pattern: "蔬菜较少" }),
    );
  });

  it("generates and displays an auditable weekly health report", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /健康/ })[0]);
    await user.click(screen.getByRole("button", { name: "趋势" }));
    await user.click(screen.getByText("一周回顾", { selector: "summary b" }));
    await user.click(await screen.findByRole("button", { name: "生成本周周报" }));
    expect(mocked.generateWeeklyReport).toHaveBeenCalledWith(expect.anything(), "m_001");
    expect(await screen.findByText(/本周可靠样本不足/)).toBeInTheDocument();
    expect(screen.getByText("依据 safety-v1 · policy-engine")).toBeInTheDocument();
  });

  it("resumes a paused household skill only after confirmation", async () => {
    const user = userEvent.setup();
    const pausedRun = {
      run_id: "run_1", member_id: "m_001", trigger: "user_message",
      goal: "帮我授权家庭成员查看", status: "paused", current_step: 2,
      max_steps: 4, result: {}, error: null,
      created_at: "2026-08-28T00:00:00Z", completed_at: null,
      steps: [
        { step_index: 1, agent_name: "main_agent", skill_name: "route_request", skill_version: "1.0.0", status: "succeeded", output_summary: {}, started_at: null, completed_at: null, error: null },
        { step_index: 2, agent_name: "household_steward", skill_name: "manage_household", skill_version: "1.0.0", status: "waiting_input", output_summary: {}, started_at: null, completed_at: null, error: null },
      ],
      handoffs: [],
    };
    mocked.agentChat.mockResolvedValueOnce({
      conversation_id: "conv_1", decision: "health_education",
      allowed_actions: ["explain"], authorization_basis: "household_owner",
      policy_version: "safety-v1", skill_version: "1.0.0", run_id: "run_1",
      message: { message_id: 3, role: "assistant", content: "请确认继续，或取消本次任务。", created_at: "2026-08-28T00:00:00Z" },
      delegated_agent: "household_steward", skill: "manage_household",
      model_version: "policy-engine",
    });
    mocked.agentRun.mockResolvedValueOnce(pausedRun);
    mocked.resumeAgentRun.mockResolvedValue({
      run: { ...pausedRun, status: "completed", steps: pausedRun.steps.map((step) => ({ ...step, status: "succeeded" })) },
      message: { message_id: 4, role: "assistant", content: "确认已收到。", created_at: "2026-08-28T00:00:01Z", model_version: "policy-engine",
        metadata: { model_route: { mode: "auto", task: "structured_action", source: "policy", reason: "rule_action" } } },
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /了解如何开始/ }));
    await user.type(screen.getByLabelText("描述你的情况"), "帮我授权家庭成员查看");
    await user.click(screen.getByRole("button", { name: "发送 →" }));
    await user.click(await screen.findByRole("button", { name: "确认继续" }));
    expect(mocked.resumeAgentRun).toHaveBeenCalledWith(expect.anything(), "run_1", true);
    expect(await screen.findByText("确认已收到。")).toBeInTheDocument();
    const resumed = screen.getByText("确认已收到。").closest(".message") as HTMLElement;
    expect(within(resumed).getByText("规则生成")).toBeVisible();
    expect(resumed).not.toHaveTextContent("deepseek-v4-pro");
  });

  it("keeps pet check-ins separate from health facts and supports a daily check-in", async () => {
    const checkedIn = await mocked.checkInPet.getMockImplementation()!(null as never, "m_001");
    mocked.checkInPet.mockImplementation(async () => {
      mocked.pet.mockResolvedValue(checkedIn.pet);
      return checkedIn;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场/ })[0]);
    expect(await screen.findByLabelText("便便宠物和皮肤图鉴")).toBeInTheDocument();
    expect(screen.getByText("可靠样本不足，宠物保持探索状态")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "今天打卡" }));
    expect(mocked.checkInPet).toHaveBeenCalledWith(expect.anything(), "m_001");
    expect(await screen.findByRole("button", { name: "今天已打卡" })).toBeDisabled();
  });

  it("changes the visible pet appearance only after a successful skin save and keeps it on failure", async () => {
    const original = await mocked.pet.getMockImplementation()!(null as never, "m_001");
    const unlocked = { ...original, unlocked_skins: ["classic", "blue_wave", "pop_star"] as typeof original.unlocked_skins };
    mocked.pet.mockResolvedValue(unlocked);
    let finishSave!: (value: typeof original) => void;
    mocked.updatePet.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await user.click(await screen.findByText("我的小屋", { selector: "summary b" }));
    const avatar = () => screen.getByRole("img", { name: "当前选中的 Agent" });
    expect(avatar()).toHaveAttribute("data-skin", "classic");
    await user.click(screen.getByRole("button", { name: "蓝色波浪" }));
    expect(avatar()).toHaveAttribute("data-skin", "classic");
    expect(screen.queryByText("宠物档案已保存。")).not.toBeInTheDocument();
    const blue = { ...unlocked, selected_skin: "blue_wave" as const };
    mocked.pet.mockResolvedValue(blue);
    await act(async () => { finishSave(blue); });
    expect(avatar()).toHaveAttribute("data-skin", "blue_wave");
    expect(screen.getByRole("img", { name: "小噗，好奇观察中" })).toHaveAttribute("data-skin", "blue_wave");
    expect(document.querySelector(".island-agent.is-mine .pet-avatar")).toHaveAttribute("data-skin", "blue_wave");
    expect(screen.getByRole("button", { name: "蓝色波浪" })).toHaveAttribute("aria-pressed", "true");
    mocked.updatePet.mockRejectedValueOnce(new ApiError(503, "SAVE_FAILED"));
    await user.click(screen.getByRole("button", { name: "波普明星" }));
    expect(await screen.findByRole("status")).toHaveTextContent("加载失败，请稍后再试。");
    expect(avatar()).toHaveAttribute("data-skin", "blue_wave");
    expect(screen.getByRole("button", { name: "波普明星" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("宠物档案已保存。")).not.toBeInTheDocument();
  });

  it("keeps a peer neutral instead of attributing the owner's saved skin to them", async () => {
    const original = await mocked.pet.getMockImplementation()!(null as never, "m_001");
    mocked.pet.mockResolvedValue({ ...original, selected_skin: "pop_star", unlocked_skins: ["classic", "pop_star"] });
    mocked.communityPosts.mockResolvedValue([{ post_id: "public_skin_test", agent_alias: "小林的 Agent", topic: "hydration", content: "公开问候", status: "active", created_at: "2026-09-18T08:00:00Z", can_withdraw: false }]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await screen.findByRole("button", { name: "今天打卡" });
    expect(screen.getByRole("img", { name: "当前选中的 Agent" })).toHaveAttribute("data-skin", "pop_star");
    await user.click(screen.getByRole("button", { name: "查看小林的 Agent" }));
    expect(screen.getByRole("img", { name: "当前选中的 Agent" })).toHaveAttribute("data-skin", "neutral");
    expect(screen.getByText("伙伴使用通用形象；未获取对方的皮肤或健康状态。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "回到我的 Agent" }));
    expect(screen.getByRole("img", { name: "当前选中的 Agent" })).toHaveAttribute("data-skin", "pop_star");
  });

  it("does not carry a pending pet skin save into another member", async () => {
    const original = await mocked.pet.getMockImplementation()!(null as never, "m_001");
    mocked.pet.mockImplementation(async (_config, memberId) => memberId === "m_001"
      ? { ...original, unlocked_skins: ["classic", "blue_wave"] }
      : { ...original, member_id: "m_002", name: "家人的伙伴" });
    let finishSave!: (value: typeof original) => void;
    mocked.updatePet.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await user.click(await screen.findByText("我的小屋", { selector: "summary b" }));
    await user.click(screen.getByRole("button", { name: "蓝色波浪" }));
    await act(async () => { window.location.hash = "#/social?member=m_002"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await screen.findByRole("heading", { name: "家人的伙伴的 Agent" });
    expect(screen.getByRole("img", { name: "当前选中的 Agent" })).toHaveAttribute("data-skin", "classic");
    await act(async () => { finishSave({ ...original, selected_skin: "blue_wave" }); });
    expect(screen.getByRole("img", { name: "当前选中的 Agent" })).toHaveAttribute("data-skin", "classic");
    expect(screen.queryByText("宠物档案已保存。")).not.toBeInTheDocument();
  });

  it("publishes to the Agent community only after explicit per-post consent", async () => {
    const published = await mocked.publishCommunityPost.getMockImplementation()!(null as never, "m_001", "hydration", "今天记得喝水");
    mocked.publishCommunityPost.mockImplementation(async () => {
      mocked.communityPosts.mockResolvedValue([published]);
      return published;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场/ })[0]);
    await user.click(await screen.findByRole("button", { name: "让 Agent 发一条 →" }));
    const publish = screen.getByRole("button", { name: "确认发布" });
    await user.type(screen.getByLabelText("公开内容"), "今天记得喝水");
    expect(publish).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(publish);
    expect(mocked.publishCommunityPost).toHaveBeenCalledWith(expect.anything(), "m_001", "hydration", "今天记得喝水");
    expect(await within(screen.getByRole("region", { name: "Agent 社区动态" })).findByText("今天记得喝水")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "让 Agent 发一条 →" }));
    const nextPost = screen.getByRole("dialog", { name: "由 Agent 代你发布" });
    expect(within(nextPost).getByRole("checkbox")).not.toBeChecked();
    expect(within(nextPost).getByRole("button", { name: "确认发布" })).toBeDisabled();
    expect(mocked.publishCommunityPost).toHaveBeenCalledTimes(1);
  });

  it("focuses the compose dialog and preserves an unapproved draft after closing and reopening", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场/ })[0]);
    const trigger = await screen.findByRole("button", { name: "让 Agent 发一条 →" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "由 Agent 代你发布" });
    const draft = within(dialog).getByRole("textbox", { name: "公开内容" });
    expect(draft).toHaveFocus();
    await user.type(draft, "我只想先写下这段草稿");
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "确认发布" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "关闭发布面板" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    const reopened = screen.getByRole("dialog", { name: "由 Agent 代你发布" });
    expect(within(reopened).getByRole("textbox", { name: "公开内容" })).toHaveValue("我只想先写下这段草稿");
    expect(within(reopened).getByRole("textbox", { name: "公开内容" })).toHaveFocus();
    expect(within(reopened).getByRole("checkbox")).not.toBeChecked();
    expect(within(reopened).getByRole("button", { name: "确认发布" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(mocked.publishCommunityPost).not.toHaveBeenCalled();
  });

  it("preserves the same member's community draft after navigating home and back", async () => {
    const originalPet = await mocked.pet.getMockImplementation()!(null as never, "m_001");
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await user.click(await screen.findByText("我的小屋", { selector: "summary b" }));
    const petName = await screen.findByRole("textbox", { name: "宠物名字" });
    await user.clear(petName);
    await user.type(petName, "还没保存的小云");
    await user.click(await screen.findByRole("button", { name: "让 Agent 发一条 →" }));
    const dialog = screen.getByRole("dialog", { name: "由 Agent 代你发布" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "社区主题" }), "routine");
    await user.type(within(dialog).getByRole("textbox", { name: "公开内容" }), "先写下，回来再继续这段草稿");
    await user.click(within(dialog).getByRole("button", { name: "关闭发布面板" }));
    await user.click(screen.getAllByRole("button", { name: /首页$/ })[0]);
    expect(await screen.findByRole("heading", { name: "小风 的便便日记" })).toBeVisible();
    const readsBeforeReturn = {
      pet: mocked.pet.mock.calls.length,
      posts: mocked.communityPosts.mock.calls.length,
      connections: mocked.agentConnections.mock.calls.length,
    };
    mocked.pet.mockResolvedValue({ ...originalPet, name: "另一端保存的小星", message: "新读取的伙伴状态", profile_version: 2 });
    mocked.communityPosts.mockResolvedValue([{
      post_id: "post_while_away", agent_alias: "小林的 Agent", topic: "routine",
      content: "离开广场后新到的公开动态", status: "active", created_at: "2026-09-10T08:00:00Z", can_withdraw: false,
    }]);
    mocked.agentConnections.mockResolvedValue([{
      connection_id: "connection_while_away", member_id: "m_001", other_agent_alias: "小林的 Agent",
      direction: "inbound", status: "connected", created_at: "2026-09-10T08:00:00Z", can_respond: false, can_end: true,
    }]);
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    expect(await screen.findByText("离开广场后新到的公开动态")).toBeVisible();
    expect(mocked.pet.mock.calls.length).toBeGreaterThan(readsBeforeReturn.pet);
    expect(mocked.communityPosts.mock.calls.length).toBeGreaterThan(readsBeforeReturn.posts);
    expect(mocked.agentConnections.mock.calls.length).toBeGreaterThan(readsBeforeReturn.connections);
    expect(screen.getByRole("textbox", { name: "宠物名字" })).toHaveValue("还没保存的小云");
    expect(screen.getByRole("img", { name: "另一端保存的小星，好奇观察中" })).toBeVisible();
    await user.click(screen.getByText("朋友码头的连接", { selector: "summary b" }));
    expect(within(screen.getByRole("region", { name: "Agent 连接" })).getByText("已连接")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "让 Agent 发一条 →" }));
    const returned = screen.getByRole("dialog", { name: "由 Agent 代你发布" });
    expect(within(returned).getByRole("combobox", { name: "社区主题" })).toHaveValue("routine");
    expect(within(returned).getByRole("textbox", { name: "公开内容" })).toHaveValue("先写下，回来再继续这段草稿");
    expect(within(returned).getByRole("checkbox")).not.toBeChecked();
    expect(within(returned).getByRole("button", { name: "确认发布" })).toBeDisabled();
    expect(mocked.publishCommunityPost).not.toHaveBeenCalled();
    expect(mocked.updatePet).not.toHaveBeenCalled();
  });

  it("does not carry a community draft or publication consent into another member", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await user.click(await screen.findByRole("button", { name: "让 Agent 发一条 →" }));
    const dialog = screen.getByRole("dialog", { name: "由 Agent 代你发布" });
    await user.type(within(dialog).getByRole("textbox", { name: "公开内容" }), "仅属于小风的公开草稿");
    await user.click(within(dialog).getByRole("checkbox"));
    expect(within(dialog).getByRole("button", { name: "确认发布" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "关闭发布面板" }));
    await user.click(screen.getAllByRole("button", { name: /首页$/ })[0]);
    await user.selectOptions(await screen.findByLabelText("首页查看哪位成员"), "m_002");
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await user.click(screen.getByRole("button", { name: "让 Agent 发一条 →" }));
    const otherMember = screen.getByRole("dialog", { name: "由 Agent 代你发布" });
    expect(within(otherMember).getByRole("textbox", { name: "公开内容" })).toHaveValue("");
    expect(within(otherMember).getByRole("checkbox")).not.toBeChecked();
    expect(within(otherMember).getByRole("button", { name: "确认发布" })).toBeDisabled();
    expect(mocked.publishCommunityPost).not.toHaveBeenCalled();
  });

  it("refreshes settings on return while preserving unsaved partner, family and connection fields", async () => {
    const originalProfile = await mocked.agentProfile.getMockImplementation()!(null as never, "m_001");
    const originalDevices = await mocked.devices.getMockImplementation()!(null as never);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /我的$/ })[0]);
    await user.click(await screen.findByRole("heading", { name: "你的健康伙伴" }));
    const nameInput = screen.getByRole("textbox", { name: "怎么称呼它" });
    await user.clear(nameInput);
    await user.type(nameInput, "还没保存的伙伴名");
    await user.click(screen.getByRole("button", { name: "＋ 添加家庭成员" }));
    await user.type(screen.getByRole("textbox", { name: "成员姓名" }), "还没加入的家人");
    await user.click(screen.getByText("开发连接设置", { selector: "summary" }));
    const apiAddress = screen.getByRole("textbox", { name: "API 地址" });
    await user.clear(apiAddress);
    await user.type(apiAddress, "http://unsaved.local:8999");
    await user.click(screen.getAllByRole("button", { name: /首页$/ })[0]);
    const readsBeforeReturn = { devices: mocked.devices.mock.calls.length, grants: mocked.grants.mock.calls.length };
    mocked.devices.mockResolvedValue([{ ...originalDevices[0], status: "offline", firmware_version: "0.9.9" }]);
    mocked.grants.mockResolvedValue([{
      grant_id: 17, household_id: "hh_001", subject_member_id: "m_001", viewer_user_id: "u_viewer",
      version: 1, status: "active", can_view: true, redline_notifications: true,
      granted_at: "2026-09-10T08:00:00Z", revoked_at: null,
    }]);
    mocked.agentProfile.mockResolvedValue({ ...originalProfile, display_name: "另一端保存的伙伴名", tone: "另一端更新的简洁语气", version: 2 });
    await user.click(screen.getAllByRole("button", { name: /我的$/ })[0]);
    expect(await screen.findByRole("button", { name: "家庭查看授权已开启" })).toBeVisible();
    expect(screen.getByText(/固件 0.9.9/)).toBeVisible();
    expect(screen.getByText(/未连接 · 已同步/)).toBeVisible();
    expect(mocked.devices.mock.calls.length).toBeGreaterThan(readsBeforeReturn.devices);
    expect(mocked.grants.mock.calls.length).toBeGreaterThan(readsBeforeReturn.grants);
    expect(screen.getByRole("textbox", { name: "怎么称呼它" })).toHaveValue("还没保存的伙伴名");
    expect(screen.getByRole("textbox", { name: "希望它怎么和你说话" })).toHaveValue("另一端更新的简洁语气");
    expect(screen.getByRole("textbox", { name: "成员姓名" })).toHaveValue("还没加入的家人");
    expect(screen.getByRole("textbox", { name: "API 地址" })).toHaveValue("http://unsaved.local:8999");
    expect(mocked.updateAgentProfile).not.toHaveBeenCalled();
    expect(mocked.createMember).not.toHaveBeenCalled();
    expect(mocked.createGrant).not.toHaveBeenCalled();
  });

  it("keeps a saved pet snapshot and newer name draft when an older activation read finishes late", async () => {
    const originalPet = await mocked.pet.getMockImplementation()!(null as never, "m_001");
    let resolveOldRead!: (value: typeof originalPet) => void;
    let resolveSave!: (value: typeof originalPet) => void;
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await user.click(await screen.findByText("我的小屋", { selector: "summary b" }));
    await screen.findByRole("textbox", { name: "宠物名字" });
    await user.click(screen.getAllByRole("button", { name: /首页$/ })[0]);
    const readsBeforeReturn = mocked.pet.mock.calls.length;
    mocked.pet.mockImplementationOnce(() => new Promise(resolve => { resolveOldRead = resolve; }));
    mocked.updatePet.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    await waitFor(() => expect(mocked.pet.mock.calls.length).toBeGreaterThan(readsBeforeReturn));
    const nameInput = screen.getByRole("textbox", { name: "宠物名字" });
    await user.clear(nameInput);
    await user.type(nameInput, "已提交的小星");
    await user.click(screen.getByRole("button", { name: "保存名字" }));
    expect(mocked.updatePet).toHaveBeenCalledWith(expect.anything(), "m_001", "已提交的小星", "classic");
    expect(screen.getByRole("button", { name: "保存名字" })).toBeDisabled();
    await user.clear(nameInput);
    await user.type(nameInput, "保存时又写的新草稿");
    const savedPet = { ...originalPet, name: "已提交的小星", profile_version: 2 };
    mocked.pet.mockResolvedValue(savedPet);
    await act(async () => { resolveSave(savedPet); });
    expect(await screen.findByRole("img", { name: "已提交的小星，好奇观察中" })).toBeVisible();
    await act(async () => { resolveOldRead({ ...originalPet, name: "迟到的旧名字" }); });
    expect(screen.getByRole("img", { name: "已提交的小星，好奇观察中" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "迟到的旧名字，好奇观察中" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "宠物名字" })).toHaveValue("保存时又写的新草稿");
    expect(mocked.updatePet).toHaveBeenCalledTimes(1);
  });

  it("lets the user explore Poop Island and greet a visible Agent", async () => {
    mocked.communityPosts.mockResolvedValue([{ post_id: "public_post", agent_alias: "小林的 Agent", topic: "hydration", content: "一起规律生活", status: "active", created_at: "2026-09-08T08:00:00Z", can_withdraw: false }]);
    mocked.requestAgentConnection.mockResolvedValue({ connection_id: "invite_1", member_id: "m_001", other_agent_alias: "小林的 Agent", direction: "outbound", status: "pending", can_respond: false, can_end: true } as never);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场/ })[0]);
    expect(await screen.findByRole("main", { name: "便便岛互动地图" })).toBeInTheDocument();
    await user.click(screen.getByText(/岛上关系 · 0 个已连接/));
    await user.click(screen.getByRole("button", { name: /小林的 Agent.*岛上可见/ }));
    await user.click(screen.getByRole("button", { name: "去打招呼" }));
    expect(mocked.requestAgentConnection).toHaveBeenCalledWith(expect.anything(), "m_001", "public_post");
    expect(await screen.findByRole("status")).toHaveTextContent("邀请已发送，等待对方明确同意。");
    await user.click(screen.getByRole("button", { name: "咖啡小屋" }));
    expect(screen.getByLabelText("社区主题")).toHaveValue("diet");
  });

  it("keeps an empty island honest when no public peers or connections exist", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /广场/ })[0]);
    await screen.findByRole("button", { name: "今天打卡" });
    await user.click(screen.getByText(/岛上关系 · 0 个已连接/));
    expect(screen.getByText("岛上伙伴 0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /小林的 Agent/ })).not.toBeInTheDocument();
    expect(screen.queryByText("☀️ 晴 · 16:20")).not.toBeInTheDocument();
  });

  it("opens the followup source report even when a newer record exists", async () => {
    mocked.sessions.mockResolvedValue([
      { session_id: "new_diary", occurred_at: "2026-09-08T08:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "新观察" },
      { session_id: "source_diary", occurred_at: "2026-09-07T08:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "源记录的观察" },
    ]);
    mocked.actionFollowups.mockResolvedValue([{ followup_id: "source_followup", member_id: "m_001", source_session_id: "source_diary", adoption_status: "accepted", observed_outcome: "pending" }] as never);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "看看这次结果 →" });
    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    await user.click(screen.getByRole("button", { name: "行动" }));
    await user.click(await screen.findByRole("button", { name: "重看这条报告 →" }));
    await waitFor(() => expect(mocked.analyzeSession).toHaveBeenCalledWith(expect.anything(), "m_001", "source_diary", undefined));
    expect(document.querySelector(".report-record-context")).toHaveTextContent("9月7日");
  });

  it("identifies the selected member in their settings and sharing controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.selectOptions(screen.getByLabelText("首页查看哪位成员"), "m_002");
    await user.click(screen.getAllByRole("button", { name: /我的/ })[0]);
    expect(await screen.findByRole("heading", { name: "家人 的小窝" })).toBeInTheDocument();
    expect(screen.getByText(/家庭查看者.*家人 的趋势/)).toBeInTheDocument();
  });

  it("requires separate explicit consent before enabling raw data uploads", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /我的/ })[0]);
    await user.click(await screen.findByText("原始数据专项授权"));
    const enable = await screen.findByRole("button", { name: "开启限期上传" });
    expect(enable).toBeDisabled();
    await user.click(screen.getByLabelText(/我已了解用途/));
    await user.click(enable);
    expect(mocked.createRawDataAuthorization).toHaveBeenCalledWith(
      expect.anything(), "dev_001", "改进传感分类模型", ["odor"], 7,
    );
  });

  it("adds a household member through the real member API", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(screen.getAllByRole("button", { name: /我的/ })[0]);
    await user.click(await screen.findByRole("button", { name: "＋ 添加家庭成员" }));
    await user.type(screen.getByLabelText("成员姓名"), "奶奶");
    await user.click(screen.getByRole("button", { name: "确认添加" }));
    expect(mocked.createMember).toHaveBeenCalledWith(expect.anything(), "奶奶");
  });

  it("keeps the home focused and progressively discloses secondary health tasks", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    expect(screen.queryByText("POOP NEWS")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /了解如何开始/ })).toHaveLength(1);

    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    expect(await screen.findByRole("region", { name: "最近记录" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^记录/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("一周回顾", { selector: "summary b" })).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "趋势" }));
    expect(screen.getByText("一周回顾", { selector: "summary b" })).toBeVisible();
    expect(screen.getByText("让 Agent 更懂你", { selector: "summary b" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "最近记录" })).not.toBeInTheDocument();
  });
});

describe("PoopSense browser navigation", () => {
  it("restores main pages, health sections and the trend range through browser back and forward", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    expect(window.location.hash).toBe("#/home?member=m_001");
    await user.click(screen.getAllByRole("button", { name: /健康$/ })[0]);
    expect(window.location.hash).toBe("#/health/records?member=m_001");
    await user.click(screen.getByRole("button", { name: "趋势" }));
    const thirtyDayRoute = window.location.hash;
    await user.click(screen.getByRole("button", { name: "90 天" }));
    expect(window.location.hash).toBe("#/health/trends?member=m_001&days=90");
    await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
    expect(window.location.hash).toBe("#/social?member=m_001");
    await user.click(screen.getAllByRole("button", { name: /我的$/ })[0]);
    expect(window.location.hash).toBe("#/settings?member=m_001");
    const historyAtSettings = window.history.length;
    await user.click(screen.getAllByRole("button", { name: /我的$/ })[0]);
    expect(window.history.length).toBe(historyAtSettings);

    await act(async () => { window.history.back(); });
    expect(await screen.findByRole("heading", { name: "便便岛" })).toBeVisible();
    expect(window.location.hash).toBe("#/social?member=m_001");
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "90 天" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "趋势" })).toHaveAttribute("aria-pressed", "true");
    expect(window.location.hash).toBe("#/health/trends?member=m_001&days=90");
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "30 天" })).toHaveAttribute("aria-pressed", "true"));
    expect(window.location.hash).toBe(thirtyDayRoute);
    await act(async () => { window.history.back(); });
    expect(await screen.findByRole("region", { name: "最近记录" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^记录/ })).toHaveAttribute("aria-pressed", "true");
    expect(window.location.hash).toBe("#/health/records?member=m_001");

    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "30 天" })).toHaveAttribute("aria-pressed", "true"));
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "90 天" })).toHaveAttribute("aria-pressed", "true"));
    await act(async () => { window.history.forward(); });
    expect(await screen.findByRole("heading", { name: "便便岛" })).toBeVisible();
    await act(async () => { window.history.forward(); });
    expect(await screen.findByRole("heading", { name: "小风 的小窝" })).toBeVisible();
    expect(window.history.length).toBe(historyAtSettings);
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  }, 10000);

  it("restores the linked member and ninety-day health section on a fresh load", async () => {
    window.history.replaceState(null, "", "/#/health/trends?member=m_002&days=90");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "家人 的记录册" })).toBeVisible();
    expect(screen.getByRole("button", { name: "趋势" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "90 天" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(mocked.trend).toHaveBeenCalledWith(expect.anything(), "m_002", 90));
    expect(mocked.sessions.mock.calls.every(([, memberId]) => memberId === "m_002")).toBe(true);
    expect(mocked.trend.mock.calls.every(([, memberId, days]) => memberId === "m_002" && days === 90)).toBe(true);
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it("opens only the linked historical report after validating it belongs to the linked member", async () => {
    const response = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_002", "linked_older");
    const records = [
      { session_id: "linked_newest", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "家人的最新记录" },
      { session_id: "linked_older", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "链接指定的旧记录" },
    ];
    let resolveRecords!: (value: typeof records) => void;
    mocked.sessions.mockImplementation(() => new Promise(resolve => { resolveRecords = resolve; }));
    mocked.analyzeSession.mockResolvedValue({ ...response, report: { ...response.report!, session_id: "linked_older", headline: "家人链接中指定的报告" } });
    window.history.replaceState(null, "", "/#/report?member=m_002&record=linked_older");
    render(<App />);
    await waitFor(() => expect(mocked.sessions).toHaveBeenCalledWith(expect.anything(), "m_002"));
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    expect(mocked.sessions.mock.calls.every(([, memberId]) => memberId === "m_002")).toBe(true);
    await act(async () => { resolveRecords(records); });
    expect(await screen.findByRole("heading", { name: "家人链接中指定的报告" })).toBeVisible();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    expect(mocked.analyzeSession).toHaveBeenCalledWith(expect.anything(), "m_002", "linked_older", undefined);
    expect(document.querySelector(".report-record-context")).toHaveTextContent("8月29日");
    expect(window.location.hash).toBe("#/report?member=m_002&record=linked_older");
  });

  it("restores the linked action source instead of the newest adopted suggestion", async () => {
    mocked.sessions.mockResolvedValue([
      { session_id: "newest_linked_action", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "较新的记录" },
      { session_id: "older_linked_action", occurred_at: "2026-08-29T12:30:00Z", assignment_version: 1, assessment_status: "assessed", risk_level: "normal", message: "链接指定来源" },
    ]);
    mocked.actionFollowups.mockResolvedValue([
      { followup_id: "newest_linked_plan", member_id: "m_001", source_session_id: "newest_linked_action", adoption_status: "accepted", observed_outcome: "pending", perceived_outcome: "pending" },
      { followup_id: "older_linked_plan", member_id: "m_001", source_session_id: "older_linked_action", adoption_status: "accepted", observed_outcome: "same", perceived_outcome: "pending" },
    ] as never);
    window.history.replaceState(null, "", "/#/health/actions?member=m_001&source=older_linked_action");
    render(<App />);
    const actionPanel = await screen.findByRole("article", { name: "行动回看" });
    expect(screen.getByRole("button", { name: "行动" })).toHaveAttribute("aria-pressed", "true");
    expect(within(actionPanel).getByRole("combobox", { name: "查看哪次建议" })).toHaveValue("older_linked_plan");
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it("shows an unavailable linked record without analyzing the member's newest record", async () => {
    mocked.sessions.mockResolvedValue([{
      session_id: "available_latest", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "可以查看的最新记录",
    }]);
    window.history.replaceState(null, "", "/#/report?member=m_001&record=missing_linked_record");
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/记录/));
    expect(mocked.sessions).toHaveBeenCalledWith(expect.anything(), "m_001");
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "这次信号已读懂，继续保持稳定节奏" })).not.toBeInTheDocument();
  });

  it("does not query an unknown linked member or substitute a known member's report", async () => {
    const allowedMembers = await mocked.members.getMockImplementation()!(null as never);
    let resolveMembers!: (value: typeof allowedMembers) => void;
    mocked.members.mockImplementationOnce(() => new Promise(resolve => { resolveMembers = resolve; }));
    mocked.sessions.mockResolvedValue([{
      session_id: "known_member_record", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "当前家庭里的记录",
    }]);
    window.history.replaceState(null, "", "/#/report?member=unknown_member&record=known_member_record");
    render(<App />);
    await waitFor(() => expect(mocked.members).toHaveBeenCalledTimes(1));
    expect(mocked.sessions).not.toHaveBeenCalled();
    expect(mocked.trend).not.toHaveBeenCalled();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
    await act(async () => { resolveMembers(allowedMembers); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/成员/));
    for (const read of [mocked.sessions, mocked.trend, mocked.actionFollowups, mocked.agentProfile, mocked.conversations, mocked.memory, mocked.healthProfile, mocked.pet, mocked.agentConnections]) {
      expect(read.mock.calls.some(([, memberId]) => memberId === "unknown_member")).toBe(false);
    }
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });

  it("does not reuse the previous member's sessions when the browser changes a report link's member", async () => {
    const response = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "first_member_only");
    const originalRecords = [{
      session_id: "first_member_only", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "仅属于小风的记录",
    }];
    let resolveOtherMember!: (value: typeof originalRecords) => void;
    mocked.sessions.mockImplementation((_config, memberId) => memberId === "m_001"
      ? Promise.resolve(originalRecords)
      : new Promise(resolve => { resolveOtherMember = resolve; }));
    mocked.analyzeSession.mockResolvedValue({ ...response, report: { ...response.report!, session_id: "first_member_only", headline: "小风的源记录报告" } });
    window.history.replaceState(null, "", "/#/report?member=m_001&record=first_member_only");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "小风的源记录报告" })).toBeVisible();
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    await act(async () => { window.location.hash = "#/report?member=m_002&record=first_member_only"; });
    await waitFor(() => expect(mocked.sessions).toHaveBeenCalledWith(expect.anything(), "m_002"));
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "小风的源记录报告" })).not.toBeInTheDocument();
    await act(async () => { resolveOtherMember([]); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/记录/));
    expect(mocked.analyzeSession).toHaveBeenCalledTimes(1);
    expect(mocked.analyzeSession).toHaveBeenCalledWith(expect.anything(), "m_001", "first_member_only", undefined);
  });

  it("returns to the original home entry after refreshing an opened report", async () => {
    const response = await mocked.analyzeSession.getMockImplementation()!(null as never, "m_001", "refresh_return_record");
    mocked.sessions.mockResolvedValue([{
      session_id: "refresh_return_record", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "从首页打开的记录",
    }]);
    mocked.analyzeSession.mockResolvedValue({ ...response, report: { ...response.report!, session_id: "refresh_return_record", headline: "刷新后仍是同一份报告" } });
    const user = userEvent.setup();
    const original = render(<App />);
    await user.click(await screen.findByRole("button", { name: "看看这次结果 →" }));
    expect(await screen.findByRole("heading", { name: "刷新后仍是同一份报告" })).toBeVisible();
    const reportRoute = window.location.hash;
    original.unmount();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "刷新后仍是同一份报告" })).toBeVisible();
    expect(window.location.hash).toBe(reportRoute);
    await user.click(screen.getByRole("button", { name: "← 返回" }));
    expect(await screen.findByRole("heading", { name: "小风 的便便日记" })).toBeVisible();
    expect(window.location.hash).toBe("#/home?member=m_001");
    expect(screen.queryByRole("heading", { name: "小风 的记录册" })).not.toBeInTheDocument();
  });

  it.each(["social while simulation is pending", "another member while receipt refresh is pending"] as const)("keeps the chosen page when navigating to %s", async (destination) => {
    const members = await mocked.members.getMockImplementation()!(null as never);
    let resolveSimulation!: (value: Awaited<ReturnType<typeof api.simulateSensor>>) => void;
    let resolveReceiptRefresh!: (value: typeof members) => void;
    mocked.simulationStatus.mockResolvedValue({ enabled: true });
    mocked.simulateSensor.mockImplementationOnce(() => new Promise(resolve => { resolveSimulation = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /了解如何开始/ });
    await user.click(await screen.findByText(/体验一次传感器检测/));
    await user.click(screen.getByRole("button", { name: "开始模拟检测" }));
    expect(mocked.simulateSensor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ member_id: "m_001" }));
    mocked.sessions.mockImplementation(async (_config, memberId) => memberId === "m_001" ? [{
      session_id: "late_simulation_for_m001", occurred_at: "2026-09-08T10:00:00Z", assignment_version: 1,
      assessment_status: "assessed", risk_level: "normal", message: "迟到的小风模拟记录", simulated: true,
    }] : []);
    if (destination === "social while simulation is pending") {
      await user.click(screen.getAllByRole("button", { name: /广场$/ })[0]);
      expect(await screen.findByRole("heading", { name: "便便岛" })).toBeVisible();
    } else {
      const memberReads = mocked.members.mock.calls.length;
      mocked.members.mockImplementationOnce(() => new Promise(resolve => { resolveReceiptRefresh = resolve; }));
      await act(async () => { resolveSimulation({ session_id: "late_simulation_for_m001", duplicate: false, assignment_status: "confirmed" }); });
      await waitFor(() => expect(mocked.members.mock.calls.length).toBeGreaterThan(memberReads));
      await user.selectOptions(screen.getByRole("combobox", { name: "首页查看哪位成员" }), "m_002");
      expect(await screen.findByRole("heading", { name: "家人 的便便日记" })).toBeVisible();
    }
    const chosenRoute = window.location.hash;
    const previousMemberReads = mocked.sessions.mock.calls.filter(([, memberId]) => memberId === "m_001").length;
    await act(async () => {
      if (destination === "social while simulation is pending") resolveSimulation({ session_id: "late_simulation_for_m001", duplicate: false, assignment_status: "confirmed" });
      else resolveReceiptRefresh(members);
    });
    expect(window.location.hash).toBe(chosenRoute);
    expect(screen.getByRole("heading", { name: destination === "social while simulation is pending" ? "便便岛" : "家人 的便便日记" })).toBeVisible();
    expect(mocked.sessions.mock.calls.filter(([, memberId]) => memberId === "m_001")).toHaveLength(previousMemberReads);
    expect(screen.queryByRole("heading", { name: "收到，这次交给我。" })).not.toBeInTheDocument();
    expect(mocked.analyzeSession).not.toHaveBeenCalled();
  });
});
