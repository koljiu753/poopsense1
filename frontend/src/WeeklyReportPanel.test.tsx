import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WeeklyReportPanel, { beijingWeekStart } from "./WeeklyReportPanel";
import { api, ApiError, type WeeklyHealthReport } from "./api";

vi.mock("./api", async importOriginal => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { weeklyReports: vi.fn(), generateWeeklyReport: vi.fn() } };
});
const mocked = vi.mocked(api);
const config = { apiBase: "", householdId: "hh_001", householdKey: "test-key" };
const friendlyError = () => "暂时无法读取，请重试。";
function report(overrides: Partial<WeeklyHealthReport> = {}): WeeklyHealthReport {
  const start = beijingWeekStart();
  return {
    report_id: "week_1", member_id: "m_001", period_start: start,
    period_end: new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10),
    status: "ready", summary: "这周已有三天留下可靠记录。", recommendations: ["保持自然记录", "不适加重时寻求专业帮助"],
    facts: { schema_version: 2, timezone: "Asia/Shanghai", data_as_of: "2026-09-18T00:30:00Z", generated_at: "2026-09-18T00:30:01Z",
      reliable_days: 3, assigned_sessions: 8, valid_sessions: 6, coverage: .75, frequency_per_week: 6, consecutive_abnormal: 0, dimensions: {}, revision: 1 },
    policy_version: "policy-test", model_version: "policy-engine", created_at: "2026-09-18T00:00:00Z", ...overrides,
  };
}
beforeEach(() => { vi.resetAllMocks(); mocked.weeklyReports.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("weekly review", () => {
  it("uses Beijing Monday boundaries regardless of the browser date", () => {
    expect(beijingWeekStart(new Date("2026-09-20T15:59:59Z"))).toBe("2026-09-14");
    expect(beijingWeekStart(new Date("2026-09-20T16:00:00Z"))).toBe("2026-09-21");
  });

  it("generates this week even when only a previous week's snapshot exists", async () => {
    mocked.weeklyReports.mockResolvedValue([report({ period_start: "2020-01-06", period_end: "2020-01-12" })]);
    mocked.generateWeeklyReport.mockResolvedValue(report());
    const user = userEvent.setup();
    render(<WeeklyReportPanel config={config} memberId="m_001" friendlyError={friendlyError} />);
    expect(await screen.findByText("本周还未生成，下面是最近保存的一周。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "生成本周周报" }));
    expect(await screen.findByRole("button", { name: "更新本周周报" })).toBeEnabled();
    expect(screen.queryByText(/本周还未生成/)).not.toBeInTheDocument();
    expect(mocked.generateWeeklyReport).toHaveBeenCalledWith(config, "m_001");
  });

  it("separates reliable days from sample quality and shows the returned newer snapshot", async () => {
    const original = report();
    mocked.weeklyReports.mockResolvedValue([original]);
    mocked.generateWeeklyReport.mockResolvedValue(report({ summary: "新记录已纳入本周回顾。", facts: { ...original.facts,
      reliable_days: 4, valid_sessions: 8, assigned_sessions: 10, coverage: .8, data_as_of: "2026-09-18T02:45:00Z", revision: 2 } }));
    const user = userEvent.setup();
    render(<WeeklyReportPanel config={config} memberId="m_001" friendlyError={friendlyError} />);
    await screen.findByText(original.summary);
    expect(screen.getByText("有可靠记录的天数").textContent).toContain("3 / 7 天");
    expect(screen.getByText("有效样本占比").textContent).toContain("75%");
    expect(screen.getByText(/数据截至 9\/18 08:30/)).toBeVisible();
    expect(screen.getByText("不适加重时寻求专业帮助")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "更新本周周报" }));
    await screen.findByText("新记录已纳入本周回顾。");
    expect(screen.getByText("有可靠记录的天数").textContent).toContain("4 / 7 天");
    expect(screen.getByText(/数据截至 9\/18 10:45/)).toBeVisible();
    expect(screen.getByText("有效样本占比").textContent).toContain("80%");
  });

  it("does not claim a new generation when the same snapshot is reused", async () => {
    mocked.weeklyReports.mockResolvedValue([report()]); mocked.generateWeeklyReport.mockResolvedValue(report());
    const user = userEvent.setup();
    render(<WeeklyReportPanel config={config} memberId="m_001" friendlyError={friendlyError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更新本周周报" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "更新本周周报" }));
    expect(await screen.findByRole("status")).toHaveTextContent("记录没有变化，已是最新周回顾。");
  });

  it("keeps legacy counts without inventing days or a natural-week cutoff", async () => {
    const old = report();
    mocked.weeklyReports.mockResolvedValue([{ ...old, facts: { valid_sessions: 6, coverage: .75,
      frequency_per_week: 6, consecutive_abnormal: 0, dimensions: {} } }]);
    render(<WeeklyReportPanel config={config} memberId="m_001" friendlyError={friendlyError} />);
    await screen.findByText(old.summary);
    expect(screen.getByText("有可靠记录的天数").textContent).toContain("— / 7 天");
    expect(screen.getByText("数据截止时间未记录")).toBeVisible();
    expect(screen.getByText(/这是旧版周报，统计窗口与截止时间未记录/)).toBeVisible();
    expect(screen.getByText(/旧版未统计可靠记录天数/)).toBeVisible();
  });

  it("ignores old member reads and writes after a member switch", async () => {
    let finishOldWrite!: (value: WeeklyHealthReport) => void;
    let finishNewRead!: (value: WeeklyHealthReport[]) => void;
    mocked.weeklyReports.mockResolvedValueOnce([report()]).mockImplementationOnce(() => new Promise(resolve => { finishNewRead = resolve; }));
    mocked.generateWeeklyReport.mockImplementationOnce(() => new Promise(resolve => { finishOldWrite = resolve; }));
    const user = userEvent.setup();
    const view = render(<WeeklyReportPanel config={config} memberId="m_001" friendlyError={friendlyError} />);
    await screen.findByText(report().summary);
    await user.click(screen.getByRole("button", { name: "更新本周周报" }));
    view.rerender(<WeeklyReportPanel config={config} memberId="m_002" friendlyError={friendlyError} />);
    expect(screen.queryByText(report().summary)).not.toBeInTheDocument();
    await act(async () => { finishOldWrite(report({ summary: "前一个成员的私密回顾" })); });
    expect(screen.queryByText("前一个成员的私密回顾")).not.toBeInTheDocument();
    await act(async () => { finishNewRead([report({ member_id: "m_002", report_id: "week_2", summary: "新成员的周回顾" })]); });
    expect(screen.getByText("新成员的周回顾")).toBeVisible();
    expect(screen.queryByText("本周回顾已更新。")).not.toBeInTheDocument();
  });

  it("does not allow generation before a failed read is retried successfully", async () => {
    mocked.weeklyReports.mockRejectedValueOnce(new ApiError(403, "NOT_AUTHORIZED")).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<WeeklyReportPanel config={config} memberId="m_001" friendlyError={friendlyError} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "生成本周周报" })).toBeDisabled();
    expect(screen.queryByText(/本周还没有周回顾/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试读取周报" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "生成本周周报" })).toBeEnabled());
    expect(mocked.generateWeeklyReport).not.toHaveBeenCalled();
  });

  it("keeps authorized history readable when update permission is denied", async () => {
    mocked.weeklyReports.mockResolvedValue([report()]); mocked.generateWeeklyReport.mockRejectedValue(new ApiError(403, "MEMORY_EDIT_NOT_AUTHORIZED"));
    const user = userEvent.setup();
    render(<WeeklyReportPanel config={config} memberId="m_001" friendlyError={friendlyError} />);
    await screen.findByText(report().summary);
    await user.click(screen.getByRole("button", { name: "更新本周周报" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("你可以阅读已授权的周回顾");
    expect(screen.getByRole("button", { name: "仅可阅读" })).toBeDisabled();
    expect(screen.getByText(report().summary)).toBeVisible();
    await user.click(screen.getByText("查看统计说明与来源"));
    expect(within(screen.getByLabelText("一周回顾")).getByText("依据 policy-test · policy-engine")).toBeVisible();
  });
});
