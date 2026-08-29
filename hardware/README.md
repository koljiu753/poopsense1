# PoopSense 硬件数据接入

本目录保存传感器侧的数据协议说明和去标识化示例数据。传感器只输出结构化观测，健康解释、成员认领、个人趋势和机器人动作由 PoopSense 后端处理。

## 示例事件

```json
{
  "event_id": "evt_demo_001",
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

## 数据边界

- `odor_change_pct` 表示设备参考值的变化，不是医学浓度。
- 温湿度表示传感器环境，不直接用于人体健康解释。
- 低质量样本会被标记为不可可靠评估。
- 未经成员认领的数据不会进入个人趋势。
- 公开示例必须使用模拟或去标识化数据。

`sample_data/bme688-demo.bmerawdata` 为 BME688 演示数据，用于开发和接口验证。
