import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type DemoExplanationResult } from "./api";
import DemoExplanation from "./DemoExplanation";

vi.mock("./api", async importOriginal => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { demoExplanation: vi.fn(), generateDemoExplanation: vi.fn() } };
});
const config = { apiBase: "", householdId: "test-family", householdKey: "demo-test-only" };
const sessionId = "manual_demo_a";
const empty: DemoExplanationResult = {
  session_id: sessionId, status: "not_generated", text: null, provider: null, model: null,
  input_version: "test-input", prompt_version: "test-prompt", attempt: 0,
  started_at: null, completed_at: null, lease_expires_at: null, error_code: null, error_message: null, retry_allowed: false,
};
const pending: DemoExplanationResult = { ...empty, status: "generating", attempt: 1, started_at: "2026-09-22T01:00:00Z", lease_expires_at: "2026-09-22T01:02:00Z" };
const completed: DemoExplanationResult = {
  ...pending, status: "completed", provider: "test-provider", model: "test-model-actual", completed_at: "2026-09-22T01:00:04Z",
  text: "这份演示样本上报了红色和条状分类。模板相似度不是准确率。气味传感器停用，没有气味读数。",
};
const failed: DemoExplanationResult = { ...pending, status: "failed", error_code: "MODEL_UNAVAILABLE", error_message: "模型暂时不可用。", retry_allowed: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.mocked(api.demoExplanation).mockResolvedValue(empty);
  vi.mocked(api.generateDemoExplanation).mockResolvedValue(completed);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("manual sample AI demonstration", () => {
  it("automatically recovers an initial read failure with GET before generating once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoExplanation).mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(empty);
    render(<DemoExplanation config={config} sessionId={sessionId} autoGenerate />);
    await screen.findByRole("alert");
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(await screen.findByText(completed.text!)).toBeVisible();
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
  });

  it("automatically checks an uncertain POST with GET but leaves a confirmed not-generated result for manual recovery", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.generateDemoExplanation).mockRejectedValue(new ApiError(408, "REQUEST_TIMEOUT"));
    render(<DemoExplanation config={config} sessionId={sessionId} autoGenerate />);
    expect(await screen.findByRole("alert")).toHaveTextContent("结果暂未确认");
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole("status")).toHaveTextContent("可手动尝试");
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
  });

  it("automatically generates only after reading a not-generated state and does not retry a failure", async () => {
    vi.mocked(api.generateDemoExplanation).mockResolvedValue(failed);
    const onSettled = vi.fn();
    render(<DemoExplanation config={config} sessionId={sessionId} autoGenerate onSettled={onSettled} />);
    expect(await screen.findByRole("button", { name: "重试生成" })).toBeVisible();
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
    expect(api.generateDemoExplanation).toHaveBeenCalledWith(config, sessionId, false, expect.any(AbortSignal));
    expect(vi.mocked(api.demoExplanation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.generateDemoExplanation).mock.invocationCallOrder[0]);
    expect(onSettled).toHaveBeenCalledWith(failed);
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新解读状态" }));
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
  });

  it.each([pending, completed, failed])("automatic mode only reads a persisted $status result", async saved => {
    vi.mocked(api.demoExplanation).mockResolvedValue(saved);
    render(<DemoExplanation config={config} sessionId={sessionId} autoGenerate />);
    await waitFor(() => expect(api.demoExplanation).toHaveBeenCalledTimes(1));
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
  });

  it("does not start automatic generation while hidden or after leaving before the initial read resolves", async () => {
    const read = deferred<DemoExplanationResult>();
    vi.mocked(api.demoExplanation).mockImplementationOnce(() => read.promise);
    const { rerender } = render(<DemoExplanation config={config} sessionId={sessionId} autoGenerate />);
    rerender(<DemoExplanation config={config} sessionId={sessionId} autoGenerate active={false} />);
    await act(async () => read.resolve(empty));
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    rerender(<DemoExplanation config={config} sessionId={sessionId} autoGenerate />);
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
    expect(api.demoExplanation).toHaveBeenCalledTimes(1);
  });

  it("reads saved state without generation and keeps the material boundary visible", async () => {
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    expect(await screen.findByRole("button", { name: "生成 AI 演示解读" })).toBeVisible();
    expect(api.demoExplanation).toHaveBeenCalledWith(config, sessionId, expect.any(AbortSignal));
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
    const panel = screen.getByRole("region", { name: "AI 演示解读" });
    expect(panel).toHaveTextContent("卡纸、橡皮泥");
    expect(panel).toHaveTextContent("不是健康报告");
    expect(panel).toHaveTextContent("模板相似度不是准确率");
    expect(panel).toHaveTextContent("停用或缺失的传感器保持未知");
  });

  it("submits one generation on double click and displays only the returned model source", async () => {
    const request = deferred<DemoExplanationResult>();
    vi.mocked(api.generateDemoExplanation).mockImplementationOnce(() => request.promise);
    const user = userEvent.setup();
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    await user.dblClick(await screen.findByRole("button", { name: "生成 AI 演示解读" }));
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
    expect(api.generateDemoExplanation).toHaveBeenCalledWith(config, sessionId, false, expect.any(AbortSignal));
    expect(screen.getByRole("status")).toHaveTextContent("请求已发送");
    expect(screen.getByText(/可以离开这个页面/)).toBeVisible();
    expect(screen.queryByText(/本次模型：/)).not.toBeInTheDocument();
    await act(async () => { request.resolve(completed); });
    expect(screen.getByRole("status")).toHaveTextContent("解读已完成");
    expect(screen.getByText("本次模型：test-provider · test-model-actual")).toBeVisible();
    expect(screen.getByText(completed.text!)).toBeVisible();
    expect(screen.queryByRole("button", { name: "生成 AI 演示解读" })).not.toBeInTheDocument();
  });

  it("resumes a pending saved job with visible GET polling and never posts on reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(false);
    vi.mocked(api.demoExplanation).mockResolvedValue(pending);
    const { unmount } = render(<DemoExplanation config={config} sessionId={sessionId} />);
    await screen.findByText("演示解读生成中。");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(true);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
    vi.mocked(api.demoExplanation).mockResolvedValue(completed);
    hidden.mockReturnValue(false);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByText(completed.text!)).toBeVisible();
    unmount();
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    expect(await screen.findByText(completed.text!)).toBeVisible();
    expect(api.demoExplanation).toHaveBeenCalledTimes(4);
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
  });

  it("pauses polling on another page and reads the persisted completion on return", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.demoExplanation).mockResolvedValue(pending);
    const { rerender } = render(<DemoExplanation config={config} sessionId={sessionId} />);
    await screen.findByText("演示解读生成中。");
    rerender(<DemoExplanation config={config} sessionId={sessionId} active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.demoExplanation).toHaveBeenCalledTimes(1);
    vi.mocked(api.demoExplanation).mockResolvedValue(completed);
    rerender(<DemoExplanation config={config} sessionId={sessionId} />);
    expect(await screen.findByText(completed.text!)).toBeVisible();
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
  });

  it("allows leaving during submission without submitting again when returning", async () => {
    const request = deferred<DemoExplanationResult>();
    vi.mocked(api.generateDemoExplanation).mockImplementationOnce(() => request.promise);
    const user = userEvent.setup();
    const { rerender } = render(<DemoExplanation config={config} sessionId={sessionId} />);
    await user.click(await screen.findByRole("button", { name: "生成 AI 演示解读" }));
    const signal = vi.mocked(api.generateDemoExplanation).mock.calls[0][3]!;
    rerender(<DemoExplanation config={config} sessionId={sessionId} active={false} />);
    expect(signal.aborted).toBe(false);
    await act(async () => { request.resolve(completed); });
    vi.mocked(api.demoExplanation).mockResolvedValue(completed);
    rerender(<DemoExplanation config={config} sessionId={sessionId} />);
    await waitFor(() => expect(api.demoExplanation).toHaveBeenCalledTimes(2));
    expect(screen.getByText(completed.text!)).toBeVisible();
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
  });

  it("shows an interrupted generation as failed and retries only after an explicit click", async () => {
    vi.mocked(api.demoExplanation).mockResolvedValue({ ...failed, error_code: "GENERATION_INTERRUPTED" });
    const user = userEvent.setup();
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    expect(await screen.findByRole("button", { name: "重试生成" })).toBeVisible();
    expect(screen.getByText(/上次生成未能完成/)).toBeVisible();
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "重试生成" }));
    expect(api.generateDemoExplanation).toHaveBeenCalledWith(config, sessionId, true, expect.any(AbortSignal));
    expect(await screen.findByText(completed.text!)).toBeVisible();
  });

  it("polls a generating POST receipt and stops after a failed job without inventing text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(api.generateDemoExplanation).mockResolvedValue(pending);
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    await user.click(await screen.findByRole("button", { name: "生成 AI 演示解读" }));
    expect(await screen.findByText("演示解读生成中。")).toBeVisible();
    vi.mocked(api.demoExplanation).mockResolvedValue(failed);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("status")).toHaveTextContent("生成失败");
    expect(screen.queryByText(/本次模型：/)).not.toBeInTheDocument();
    expect(screen.queryByText(completed.text!)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(api.demoExplanation).toHaveBeenCalledTimes(2);
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
  });

  it("treats a transport failure as uncertain and offers a GET check before any further POST", async () => {
    vi.mocked(api.generateDemoExplanation).mockRejectedValue(new ApiError(408, "REQUEST_TIMEOUT"));
    const user = userEvent.setup();
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    await user.click(await screen.findByRole("button", { name: "生成 AI 演示解读" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("结果暂未确认");
    expect(screen.queryByRole("button", { name: "生成 AI 演示解读" })).not.toBeInTheDocument();
    vi.mocked(api.demoExplanation).mockResolvedValue(pending);
    await user.click(screen.getByRole("button", { name: "重新读取状态" }));
    expect(await screen.findByText("演示解读生成中。")).toBeVisible();
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])("clears saved text and source when permission or record lookup returns %s", async status => {
    vi.mocked(api.demoExplanation).mockResolvedValue(completed);
    const user = userEvent.setup();
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    await screen.findByText(completed.text!);
    vi.mocked(api.demoExplanation).mockRejectedValue(new ApiError(status, "private service detail"));
    await user.click(screen.getByRole("button", { name: "刷新解读状态" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(completed.text!)).not.toBeInTheDocument();
    expect(screen.queryByText(/本次模型：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private service detail/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "AI 演示解读" })).toHaveTextContent("不是健康报告");
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
  });

  it("does not display a late generation for A after searching B", async () => {
    const request = deferred<DemoExplanationResult>();
    vi.mocked(api.generateDemoExplanation).mockImplementationOnce(() => request.promise);
    const user = userEvent.setup();
    const { rerender } = render(<DemoExplanation config={config} sessionId={sessionId} />);
    await user.click(await screen.findByRole("button", { name: "生成 AI 演示解读" }));
    const signal = vi.mocked(api.generateDemoExplanation).mock.calls[0][3]!;
    vi.mocked(api.demoExplanation).mockResolvedValue({ ...empty, session_id: "manual_demo_b" });
    rerender(<DemoExplanation config={config} sessionId="manual_demo_b" />);
    expect(signal.aborted).toBe(true);
    await screen.findByRole("button", { name: "生成 AI 演示解读" });
    await act(async () => { request.resolve(completed); });
    expect(screen.queryByText(completed.text!)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("尚未生成");
    expect(api.generateDemoExplanation).toHaveBeenCalledTimes(1);
  });

  it("isolates changed family credentials and ignores a late old GET or a mismatched record response", async () => {
    const oldRead = deferred<DemoExplanationResult>();
    vi.mocked(api.demoExplanation).mockImplementationOnce(() => oldRead.promise);
    const { rerender } = render(<DemoExplanation config={config} sessionId={sessionId} />);
    const signal = vi.mocked(api.demoExplanation).mock.calls[0][2]!;
    const nextConfig = { ...config, householdId: "another-family", householdKey: "different-test-only" };
    vi.mocked(api.demoExplanation).mockResolvedValue({ ...completed, session_id: "wrong_record" });
    rerender(<DemoExplanation config={nextConfig} sessionId={sessionId} />);
    expect(signal.aborted).toBe(true);
    await screen.findByRole("alert");
    await act(async () => { oldRead.resolve(completed); });
    expect(screen.queryByText(completed.text!)).not.toBeInTheDocument();
    expect(screen.queryByText(/本次模型：/)).not.toBeInTheDocument();
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
  });

  it("does not offer retry when the service disallows it and renders completed Markdown safely", async () => {
    vi.mocked(api.demoExplanation).mockResolvedValue({ ...failed, retry_allowed: false });
    const user = userEvent.setup();
    render(<DemoExplanation config={config} sessionId={sessionId} />);
    await screen.findByText("本次演示解读生成失败。");
    expect(screen.queryByRole("button", { name: "重试生成" })).not.toBeInTheDocument();
    vi.mocked(api.demoExplanation).mockResolvedValue({ ...completed, text: "**仅为演示**\n\n<script>window.demoUnsafe = true</script>\n\n![sample](https://invalid.example/image.png)\n\n[继续](javascript:alert(1))" });
    await user.click(screen.getByRole("button", { name: "刷新解读状态" }));
    const panel = screen.getByRole("region", { name: "AI 演示解读" });
    expect(await within(panel).findByText("仅为演示")).toBeVisible();
    expect(panel.querySelector("script, img, a[href^='javascript:']")).toBeNull();
    expect(api.generateDemoExplanation).not.toHaveBeenCalled();
  });
});
