import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type HouseholdSession } from "./api";
import FamilyConnectionSettings from "./FamilyConnectionSettings";
import RecordLookup from "./RecordLookup";
import RecordObservations from "./RecordObservations";

vi.mock("./api", async importOriginal => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { members: vi.fn(), sessionById: vi.fn() } };
});
const config = { apiBase: "", householdId: "test-family", householdKey: "test-only-family-key" };
const members = [{ member_id: "test_member", display_name: "测试成员", linked_to_current_user: true }];
const sample: HouseholdSession = {
  session_id: "manual_older_than_50", device_id: "test_device", correlation_id: "cor_manual", received_at: "2026-09-21T08:00:00Z",
  data_kind: "hardware_test", assignment_status: "pending_claim", assignment_version: 1, member_id: null,
  raw_observations: {
    shape: { value: "elongated", confidence: null, missing_reason: null, source: "adapter", model_version: "shape-test" },
    color: { value: "red", confidence: null, missing_reason: null, source: "adapter", model_version: "color-test", template_similarity: 92.5, similarity_scale: "0_100" },
    odor: { value: null, confidence: null, missing_reason: "sensor_disabled", source: "adapter", model_version: "odor-test" },
  },
  sampling: { session_kind: "manual_sampling", duration_semantics: "manual_sampling_seconds", duration_s: 12, started_at: "2026-09-21T16:00:00+08:00", ended_at: "2026-09-21T16:00:12+08:00", presence_state: "unknown", collection_state: "partial", temperature_c: null, humidity_pct: null },
  processing: { analysis_complete: true, analysis_source: "rules", assessment_status: "unable_to_determine", reliable: false, risk_level: "not_evaluated", message: "本次无法可靠判断", reasons: ["collection_not_completed"], llm_status: "not_applicable" },
};
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.members).mockResolvedValue(members); vi.mocked(api.sessionById).mockResolvedValue(sample); });
afterEach(cleanup);

describe("original observations", () => {
  it("shows partial hardware classifications and missing sensors without converting similarity or sampling into health facts", () => {
    render(<RecordObservations record={sample} expanded />);
    expect(screen.getByRole("region", { name: "形状原始观测" })).toHaveTextContent("条状（elongated）");
    const color = screen.getByRole("region", { name: "颜色原始观测" });
    expect(color).toHaveTextContent("红色（red）");
    expect(color).toHaveTextContent("92.5 · 量纲：0–100");
    expect(color).not.toHaveTextContent("92.5%");
    expect(screen.getByRole("region", { name: "气味原始观测" })).toHaveTextContent("传感器停用（sensor_disabled）");
    expect(screen.getByRole("region", { name: "采样信息" })).toHaveTextContent("手动采样时长12 秒（不是如厕时长）");
    expect(screen.getByText("2026-09-21T16:00:00+08:00")).toBeVisible();
    expect(screen.getByRole("region", { name: "记录处理状态" })).toHaveTextContent("规则处理已完成 · 无法可靠判断健康状态");
    expect(screen.getByText(/本次手动采样不适用大模型健康报告/)).toBeVisible();
  });

  it("preserves an unscaled score as a raw number instead of guessing a percentage", () => {
    render(<RecordObservations record={{ ...sample, raw_observations: { ...sample.raw_observations, color: { ...sample.raw_observations!.color, template_similarity: 127.4, similarity_scale: "unknown" } } }} expanded />);
    expect(screen.getByRole("region", { name: "颜色原始观测" })).toHaveTextContent("127.4 · 量纲：未说明");
  });

  it("does not invent observation or processing facts for legacy records", () => {
    render(<RecordObservations record={{ session_id: "old_record" }} expanded />);
    expect(screen.getByText("这条旧记录尚未提供原始观测详情。")).toBeVisible();
    expect(screen.queryByText("规则处理已完成")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "颜色原始观测" })).not.toBeInTheDocument();
  });

  it.each([
    ["not_requested", "未发起大模型报告"], ["policy_only", "已有规则报告，未调用大模型"], ["available", "已有模型报告"],
  ] as const)("keeps %s model status separate from rule completion", (status, expected) => {
    render(<RecordObservations record={{ session_id: "rules_record", processing: { ...sample.processing!, llm_status: status } }} expanded />);
    expect(screen.getByText(`大模型：${expected}`)).toBeVisible();
    expect(screen.getByText("规则处理已完成")).toBeVisible();
  });
});

describe("authorized record lookup", () => {
  it("looks up the exact older record independently of the recent list and can refresh the pending inbox", async () => {
    const refresh = vi.fn();
    const user = userEvent.setup();
    render(<RecordLookup config={config} members={members} onRefreshInbox={refresh} />);
    await user.type(screen.getByLabelText("查找记录 ID"), ` ${sample.session_id} `);
    await user.click(screen.getByRole("button", { name: "查找" }));
    expect(await screen.findByRole("article", { name: "记录查找结果" })).toHaveTextContent("红色（red）");
    expect(api.sessionById).toHaveBeenCalledWith(config, sample.session_id, expect.any(AbortSignal));
    expect(screen.getByText("硬件上传 · 测试记录")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "刷新待认领箱" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.mocked(api.sessionById).mockResolvedValue({ ...sample, assignment_status: "confirmed", member_id: "test_member" });
    await user.click(screen.getByRole("button", { name: "刷新这条记录" }));
    expect(await screen.findByText("已归属：测试成员")).toBeVisible();
  });

  it.each([[403, "当前家庭授权无法查看"], [404, "当前家庭中未找到"], [409, "这个记录 ID 对应多个设备"]] as const)("removes old results when a lookup is rejected with %s", async (status, message) => {
    const user = userEvent.setup();
    render(<RecordLookup config={config} members={members} onRefreshInbox={vi.fn()} />);
    await user.type(screen.getByLabelText("查找记录 ID"), sample.session_id);
    await user.click(screen.getByRole("button", { name: "查找" }));
    await screen.findByRole("article", { name: "记录查找结果" });
    vi.mocked(api.sessionById).mockRejectedValue(new ApiError(status, "private server detail"));
    await user.click(screen.getByRole("button", { name: "刷新这条记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("article", { name: "记录查找结果" })).not.toBeInTheDocument();
    expect(screen.queryByText(/private server detail/)).not.toBeInTheDocument();
  });

  it("cancels the old identity's lookup and ignores its late response", async () => {
    let finish!: (value: HouseholdSession) => void;
    vi.mocked(api.sessionById).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup();
    const { rerender } = render(<RecordLookup config={config} members={members} onRefreshInbox={vi.fn()} />);
    await user.type(screen.getByLabelText("查找记录 ID"), sample.session_id);
    await user.dblClick(screen.getByRole("button", { name: "查找" }));
    expect(api.sessionById).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(api.sessionById).mock.calls[0][2]!;
    rerender(<RecordLookup config={{ ...config, householdKey: "changed-test-credential" }} members={members} onRefreshInbox={vi.fn()} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(sample); });
    expect(screen.queryByRole("article", { name: "记录查找结果" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("查找记录 ID")).toHaveValue("");
  });
});

describe("family connection", () => {
  it("checks the supplied family before saving and does not submit twice", async () => {
    let finish!: (value: typeof members) => void;
    vi.mocked(api.members).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const save = vi.fn();
    const user = userEvent.setup();
    render(<FamilyConnectionSettings config={config} onSave={save} initiallyOpen />);
    await user.clear(screen.getByLabelText("家庭 ID"));
    await user.type(screen.getByLabelText("家庭 ID"), " independent_test ");
    await user.dblClick(screen.getByRole("button", { name: "保存并重新连接" }));
    expect(save).not.toHaveBeenCalled();
    expect(api.members).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("家庭访问密钥")).toHaveAttribute("type", "password");
    await act(async () => { finish(members); });
    expect(save).toHaveBeenCalledWith({ ...config, householdId: "independent_test" });
  });

  it.each(["denied", "empty"])("keeps the existing connection when the new family is %s", async outcome => {
    if (outcome === "denied") vi.mocked(api.members).mockRejectedValue(new ApiError(403, "private detail"));
    else vi.mocked(api.members).mockResolvedValue([]);
    const save = vi.fn();
    const user = userEvent.setup();
    render(<FamilyConnectionSettings config={config} onSave={save} initiallyOpen />);
    await user.click(screen.getByRole("button", { name: "保存并重新连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前连接未切换");
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("家庭访问密钥")).toHaveValue(config.householdKey);
    expect(screen.getByRole("alert")).not.toHaveTextContent(config.householdKey);
  });
});
