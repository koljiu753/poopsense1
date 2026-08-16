export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    service: "poopsense-hardware-analysis-mvp",
    version: "0.4.0",
    model: "deepseek-v4-flash"
  });
}
