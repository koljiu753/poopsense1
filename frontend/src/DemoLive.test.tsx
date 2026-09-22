import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DemoLive from "./DemoLive";
import { api, ApiError, type DemoExplanationResult, type DemoSessionFeed, type HouseholdSession } from "./api";
import { readRoute, routeHash } from "./useAppNavigation";

vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), api: {
  devices: vi.fn(), demoSessions: vi.fn(), sessionById: vi.fn(), demoExplanation: vi.fn(), generateDemoExplanation: vi.fn(),
} }));
const config = { apiBase: "", householdId: "test-family", householdKey: "mock-only" };
const device = { device_id: "demo_device_a", household_id: config.householdId, active: true, status: "online", firmware_version: null, model_version: null, last_seen_at: null, privacy_mode: "features_only" };
function sample(id: string, color = "red", shape = "elongated"): HouseholdSession & { cursor_id: number } {
  const observation = (value: string) => ({ value, confidence: null, missing_reason: null, source: "demo", model_version: "demo" });
  return { session_id: id, cursor_id: id === "demo_a" ? 1 : 2, device_id: device.device_id, correlation_id: id, received_at: "2026-09-22T02:00:00Z", data_kind: "simulated", assignment_status: "pending_claim", assignment_version: 1, member_id: null,
    raw_observations: { color: observation(color), shape: observation(shape) }, sampling: { session_kind: "manual_sampling", duration_semantics: "manual_sampling_seconds", started_at: "2026-09-22T01:59:50Z", ended_at: "2026-09-22T02:00:00Z", duration_s: 10, presence_state: "unknown", collection_state: "partial", temperature_c: null, humidity_pct: null },
  };
}
function explanation(id: string, status: DemoExplanationResult["status"] = "completed"): DemoExplanationResult {
  return { session_id: id, status, text: status === "completed" ? `模型仅解释演示记录 ${id}。` : null, provider: status === "completed" ? "mock-provider" : null, model: status === "completed" ? "mock-model" : null,
    input_version: "v1", prompt_version: "v1", attempt: status === "not_generated" ? 0 : 1, started_at: null, completed_at: null, lease_expires_at: null, error_code: status === "failed" ? "MODEL_UNAVAILABLE" : null, error_message: null, retry_allowed: status === "failed" };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const props = { config, active: true, onSettings: vi.fn(), onRecords: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.mocked(api.devices).mockResolvedValue([device]);
  vi.mocked(api.demoSessions).mockResolvedValue({ items: [], next_after_id: 0, has_more: false });
  vi.mocked(api.demoExplanation).mockImplementation(async (_c, id) => explanation(id, "not_generated"));
  vi.mocked(api.generateDemoExplanation).mockImplementation(async (_c, id) => explanation(id));
  vi.mocked(api.sessionById).mockImplementation(async (_c, id) => sample(id, id === "demo_b" ? "blue" : "red", id === "demo_b" ? "scattered" : "elongated"));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("automatic hardware demonstration", () => {
  it("stops automatic reads after authentication expires until an explicit reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoSessions).mockResolvedValue({ items: [sample("demo_a")], next_after_id: 1, has_more: false });
    vi.mocked(api.sessionById).mockResolvedValueOnce(sample("demo_a")).mockRejectedValue(new ApiError(401, "expired"));
    render(<DemoLive {...props} />);
    await screen.findByText("模型仅解释演示记录 demo_a。");
    await act(async () => { await vi.advanceTimersByTimeAsync(5200); });
    expect(screen.queryByRole("article", { name: "当前演示记录" })).not.toBeInTheDocument();
    const reads = vi.mocked(api.demoSessions).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.demoSessions).toHaveBeenCalledTimes(reads);
    expect(api.sessionById).toHaveBeenCalledTimes(2);
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
  });

  it("removes an inaccessible queued record and continues B without leaking A or generating for it", async () => {
    vi.mocked(api.demoSessions).mockResolvedValue({ items: [sample("demo_a"), sample("demo_b", "blue", "scattered")], next_after_id: 2, has_more: false });
    vi.mocked(api.demoExplanation).mockImplementation(async (_c, id) => {
      if (id === "demo_a") throw new ApiError(403, "private-revoked");
      return explanation(id, "not_generated");
    });
    render(<DemoLive {...props} />);
    expect(await screen.findByText("模型仅解释演示记录 demo_b。")).toBeVisible();
    expect(screen.getByRole("article", { name: "当前演示记录" })).toHaveAttribute("data-demo-session", "demo_b");
    expect(screen.queryByText(/demo_a/)).not.toBeInTheDocument();
    expect(vi.mocked(api.generateDemoExplanation).mock.calls.map(call => call[1])).toEqual(["demo_b"]);
  });

  it("rechecks only the displayed completed record and removes its observations when access is revoked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoSessions).mockResolvedValue({ items: [sample("demo_a")], next_after_id: 1, has_more: false });
    vi.mocked(api.sessionById).mockResolvedValueOnce(sample("demo_a")).mockRejectedValue(new ApiError(403, "private-revoked"));
    render(<DemoLive {...props} />);
    await screen.findByText("模型仅解释演示记录 demo_a。");
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    expect(api.sessionById).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByRole("article", { name: "当前演示记录" })).not.toBeInTheDocument();
    expect(screen.queryByText(/demo_a/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "本条记录复查状态" })).toHaveTextContent("已移除其观测和解读");
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole("article", { name: "当前演示记录" })).not.toBeInTheDocument();
    expect(api.sessionById).toHaveBeenCalledTimes(2);
  });

  it("updates assignment without regenerating the completed answer or replacing the reading controls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoSessions).mockResolvedValueOnce({ items: [sample("demo_a")], next_after_id: 1, has_more: false }).mockResolvedValue({ items: [], next_after_id: 1, has_more: false });
    vi.mocked(api.sessionById).mockResolvedValueOnce(sample("demo_a")).mockResolvedValue({ ...sample("demo_a"), member_id: "explicit_test_member", assignment_status: "confirmed" });
    render(<DemoLive {...props} />);
    await screen.findByText("模型仅解释演示记录 demo_a。");
    const control = screen.getByRole("button", { name: "刷新解读状态" });
    control.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(5200); });
    expect(screen.getByText("已归属：explicit_test_member")).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新解读状态" })).toBe(control);
    expect(control).toHaveFocus();
    expect(api.demoExplanation).toHaveBeenCalledTimes(1);
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
  });

  it("uses a family-only route and waits for new uploads without asking for an ID", async () => {
    expect(readRoute("#/demo?member=someone").memberId).toBe("");
    expect(routeHash({ ...readRoute("#/demo"), memberId: "someone" })).toBe("#/demo");
    render(<DemoLive {...props} />);
    expect(await screen.findByText("设备就绪，等待这次测量。")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "演示设备" })).toHaveValue(device.device_id);
    expect(api.demoSessions).toHaveBeenCalledWith(config, device.device_id, undefined, expect.any(AbortSignal));
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows actual tags first and automatically explains the same unclaimed record", async () => {
    const generated = deferred<DemoExplanationResult>();
    vi.mocked(api.demoSessions).mockResolvedValue({ items: [sample("demo_a")], next_after_id: 1, has_more: false });
    vi.mocked(api.generateDemoExplanation).mockImplementationOnce(() => generated.promise);
    render(<DemoLive {...props} />);
    const card = await screen.findByRole("article", { name: "当前演示记录" });
    expect(card.querySelector('[data-demo-shape="elongated"][data-demo-color="red"]')).not.toBeNull();
    expect(card).toHaveTextContent("未认领");
    await waitFor(() => expect(api.generateDemoExplanation).toHaveBeenCalledWith(config, "demo_a", false, expect.any(AbortSignal)));
    expect(screen.queryByText("模型仅解释演示记录 demo_a。")).not.toBeInTheDocument();
    await act(async () => generated.resolve(explanation("demo_a")));
    expect(await screen.findByText("模型仅解释演示记录 demo_a。")).toBeVisible();
  });

  it("drains cursor pages immediately and processes two records in arrival order without mixing answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoSessions).mockResolvedValueOnce({ items: [sample("demo_a")], next_after_id: 1, has_more: true })
      .mockResolvedValue({ items: [sample("demo_b", "blue", "scattered")], next_after_id: 2, has_more: false });
    render(<DemoLive {...props} />);
    expect(await screen.findByText("模型仅解释演示记录 demo_a。")).toBeVisible();
    expect(api.demoSessions).toHaveBeenNthCalledWith(2, config, device.device_id, 1, expect.any(AbortSignal));
    expect(screen.getByText(/后面还有 1 条/)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    expect(await screen.findByText("模型仅解释演示记录 demo_b。")).toBeVisible();
    expect(screen.queryByText("模型仅解释演示记录 demo_a。")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "当前演示记录" }).querySelector('[data-demo-shape="scattered"][data-demo-color="blue"]')).not.toBeNull();
    expect(vi.mocked(api.generateDemoExplanation).mock.calls.map(call => call[1])).toEqual(["demo_a", "demo_b"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(2);
  });

  it("restores queued IDs after reload and reads a completed result without generating it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoSessions).mockResolvedValueOnce({ items: [sample("demo_a"), sample("demo_b")], next_after_id: 2, has_more: false })
      .mockResolvedValue({ items: [], next_after_id: 2, has_more: false });
    const first = render(<DemoLive {...props} />);
    await screen.findByText("模型仅解释演示记录 demo_a。");
    first.unmount();
    vi.mocked(api.demoExplanation).mockImplementation(async (_c, id) => explanation(id, id === "demo_a" ? "completed" : "not_generated"));
    render(<DemoLive {...props} />);
    expect(await screen.findByText("模型仅解释演示记录 demo_a。")).toBeVisible();
    expect(api.sessionById).toHaveBeenCalledWith(config, "demo_b", expect.any(AbortSignal));
    expect(api.demoSessions).toHaveBeenLastCalledWith(config, device.device_id, 2, expect.any(AbortSignal));
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    await screen.findByText("模型仅解释演示记录 demo_b。");
    expect(vi.mocked(api.generateDemoExplanation).mock.calls.map(call => call[1])).toEqual(["demo_a", "demo_b"]);
  });

  it("pauses in the background and catches the next record with the existing cursor on return", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, "hidden", "get"); hidden.mockReturnValue(false);
    const view = render(<DemoLive {...props} />);
    await screen.findByText("设备就绪，等待这次测量。");
    hidden.mockReturnValue(true); act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.demoSessions).toHaveBeenCalledTimes(1);
    vi.mocked(api.demoSessions).mockResolvedValue({ items: [sample("demo_a")], next_after_id: 1, has_more: false });
    hidden.mockReturnValue(false); act(() => document.dispatchEvent(new Event("visibilitychange")));
    await screen.findByText("模型仅解释演示记录 demo_a。");
    expect(api.demoSessions).toHaveBeenLastCalledWith(config, device.device_id, 0, expect.any(AbortSignal));
    view.rerender(<DemoLive {...props} active={false} />);
    const reads = vi.mocked(api.demoSessions).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.demoSessions).toHaveBeenCalledTimes(reads);
  });

  it("remembers an explicit device choice but isolates a late result after selecting another", async () => {
    const old = deferred<DemoSessionFeed>();
    const deviceB = { ...device, device_id: "demo_device_b" };
    vi.mocked(api.devices).mockResolvedValue([device, deviceB]);
    vi.mocked(api.demoSessions).mockImplementationOnce(() => old.promise);
    const user = userEvent.setup();
    const mounted = render(<DemoLive {...props} />);
    const select = await screen.findByRole("combobox", { name: "演示设备" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(api.demoSessions).not.toHaveBeenCalled();
    await user.selectOptions(select, device.device_id);
    const oldSignal = vi.mocked(api.demoSessions).mock.calls[0][3]!;
    await user.selectOptions(select, deviceB.device_id);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => old.resolve({ items: [sample("demo_a")], next_after_id: 1, has_more: false }));
    expect(screen.queryByText(/本条记录：/)).not.toBeInTheDocument();
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
    mounted.unmount(); render(<DemoLive {...props} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "演示设备" })).toHaveValue(deviceB.device_id));
  });

  it("clears old data and pending requests when the family or credentials change", async () => {
    const old = deferred<DemoSessionFeed>();
    vi.mocked(api.demoSessions).mockImplementationOnce(() => old.promise);
    const view = render(<DemoLive {...props} />);
    await waitFor(() => expect(api.demoSessions).toHaveBeenCalledTimes(1));
    const nextConfig = { ...config, householdKey: "changed-mock-only" };
    vi.mocked(api.devices).mockResolvedValue([]);
    view.rerender(<DemoLive {...props} config={nextConfig} />);
    await act(async () => old.resolve({ items: [sample("demo_a")], next_after_id: 1, has_more: false }));
    expect(screen.queryByRole("article", { name: "当前演示记录" })).not.toBeInTheDocument();
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
  });

  it("keeps a failed result available for explicit retry while advancing the next record", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoSessions).mockResolvedValue({ items: [sample("demo_a"), sample("demo_b")], next_after_id: 2, has_more: false });
    vi.mocked(api.generateDemoExplanation).mockImplementation(async (_c, id) => explanation(id, id === "demo_a" ? "failed" : "completed"));
    render(<DemoLive {...props} />);
    expect(await screen.findByRole("button", { name: "重试生成" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    await screen.findByText("模型仅解释演示记录 demo_b。");
    await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(2);
    vi.mocked(api.demoExplanation).mockImplementation(async (_c, id) => explanation(id, id === "demo_a" ? "failed" : "completed"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByText("本轮已处理 2 条"));
    await user.click(screen.getByRole("button", { name: "回看记录 demo_a" }));
    expect(await screen.findByRole("button", { name: "重试生成" })).toBeVisible();
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "重试生成" }));
    expect(api.generateDemoExplanation).toHaveBeenLastCalledWith(config, "demo_a", true, expect.any(AbortSignal));
  });

  it("keeps the cursor on a network failure and clears observations on permission loss", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoSessions).mockResolvedValueOnce({ items: [sample("demo_a")], next_after_id: 1, has_more: false })
      .mockRejectedValueOnce(new TypeError("offline")).mockRejectedValue(new ApiError(403, "private-detail"));
    render(<DemoLive {...props} />);
    await screen.findByText("模型仅解释演示记录 demo_a。");
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(screen.getByRole("alert")).toHaveTextContent("已有内容保留");
    expect(screen.getByText("模型仅解释演示记录 demo_a。")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.demoSessions).toHaveBeenLastCalledWith(config, device.device_id, 1, expect.any(AbortSignal));
    expect(screen.queryByRole("article", { name: "当前演示记录" })).not.toBeInTheDocument();
    expect(screen.queryByText(/private-detail/)).not.toBeInTheDocument();
  });
});
