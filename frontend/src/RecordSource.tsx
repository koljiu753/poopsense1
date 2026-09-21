import type { DataKind } from "./api";

export function recordSourceLabel(record?: { data_kind?: DataKind; simulated?: boolean }) {
  if (record?.data_kind === "hardware_test") return "硬件上传 · 测试记录";
  if (record?.data_kind === "simulated" || record?.simulated === true) return "模拟记录";
  return "";
}

export default function RecordSource({ record }: { record: { data_kind?: DataKind; simulated?: boolean } }) {
  const label = recordSourceLabel(record);
  return label ? <small className="record-source-label">{label}</small> : null;
}
