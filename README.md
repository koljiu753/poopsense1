# PoopSense Frontend + Hardware Analysis API MVP

目标：在不依赖旧前端源码和数据库的情况下，打通：

`硬件 Python JSON -> Vercel API -> 安全分析 JSON`

同时包含无需登录的响应式联调前端。前端可编辑传感器 JSON、调用真实 API，并展示注意等级、传感器特征、DeepSeek 使用状态和安全建议。

## 接口

- `GET /api/health`
- `POST /api/analyze`
- `/`：前端联调与报告页面

当前兼容硬件团队的 JSON：

```json
{
  "event_id": "evt_001",
  "color_category": "brown_like",
  "color_confidence": 0.82,
  "odor_deviation": "moderate",
  "odor_change_pct": 31.2,
  "odor_confidence": 0.71,
  "temperature_c": 24.8,
  "humidity_pct": 63.1,
  "sample_quality": "usable"
}
```

## Python 调用

```python
import requests

url = "https://YOUR_PREVIEW_URL/api/analyze"
payload = {
    "event_id": "evt_001",
    "color_category": "brown_like",
    "color_confidence": 0.82,
    "odor_deviation": "moderate",
    "odor_change_pct": 31.2,
    "odor_confidence": 0.71,
    "temperature_c": 24.8,
    "humidity_pct": 63.1,
    "sample_quality": "usable",
}

response = requests.post(url, json=payload, timeout=15)
response.raise_for_status()
print(response.json())
```

接口必须携带单独提供的临时设备密钥：

```python
headers = {"X-PoopSense-Device-Key": "从 PoopSense-device-key.txt 读取"}
response = requests.post(url, json=payload, headers=headers, timeout=15)
```

不要把设备密钥写进仓库或聊天记录。

## MVP 边界

- 当前先由确定性规则固定注意等级，再通过 DeepSeek API 调用 `deepseek-v4-flash` 生成解释。
- DeepSeek 密钥只存放在 Vercel Preview 环境变量 `DEEPSEEK_API_KEY` 中。
- 模型不能修改注意等级；输出不合格或调用失败时自动回退安全模板。
- 没有成员历史数据库，所以个人时间轴返回 `not_evaluable`。
- 环境温湿度仅作为传感器环境数据，不用于人体健康解释。
- 特殊颜色只返回 `confirm_prompt`，不推测疾病。
- 仅建议使用模拟数据或去标识化数据测试公开 Preview。
- MVP 前端把临时设备密钥放在 `sessionStorage`，关闭浏览器会话后清除；正式产品应改用用户登录态。
- MVP 不保存事件历史。硬件请求会获得完整分析结果，但不会自动同步到其他浏览器。
