# PoopSense 硬件与数据接入

PoopSense 感知器由四类传感器、ESP32 和电脑端 Python Adapter 组成。传感器负责采集原始特征，ESP32 统一读取与传输，Python Adapter 完成解析、特征提取、分类与 JSON 封装；健康解释、成员认领、个人趋势和机器人动作由 PoopSense 后端处理。

## 传感器与字段映射

| 传感器 | 原始用途 | 边缘计算输出 | PoopSense 字段 |
| --- | --- | --- | --- |
| BME688 | 气体响应、温度和湿度采样 | 气味特征类别、变化率与置信度 | `observations.odor`、`temperature_c`、`humidity_pct` |
| APDS9960 | 接近/在场检测 | 检测流程开始、结束和在场状态 | `presence_state`、采集状态机 |
| MLX90640 | 低分辨率热成像 | 隐私友好的形状特征与分类结果 | `observations.shape` |
| AS7341 | 多通道颜色采样 | 红、绿、黄、蓝等颜色类别与置信度 | `observations.color` |

BME688 的气体类型分类能力预留在 Python Adapter 一侧扩展；MLX90640 的形状分类结果也由 Adapter 统一封装。模型输出必须同时携带置信度与版本号。原始热阵列、光谱和气体响应数据默认不进入长期趋势，仅在获得专项授权后用于模型改进。

## 数据链路

```text
BME688 / APDS9960 / MLX90640 / AS7341
                  ↓
                ESP32
                  ↓ USB Serial
     MacBook / Edge Device（Python Adapter）
                  ↓
       解析 → 特征提取 → 分类 → 质量评估
                  ↓
          PoopSense Session JSON
                  ↓ HTTP
          FastAPI → App / AI Agent
```

## Python Adapter 输出示例

以下示例与后端 `DeviceSessionInput` 数据契约一致：

```json
{
  "schema_version": "1.0",
  "session_id": "session_demo_001",
  "correlation_id": "corr_demo_001",
  "device_id": "dev_001",
  "household_id": "hh_001",
  "firmware_version": "esp32-0.1.0",
  "model_version": "adapter-0.1.0",
  "sequence_number": 1,
  "source": "device",
  "timestamp": "2026-08-30T10:00:00+08:00",
  "end_timestamp": "2026-08-30T10:00:12+08:00",
  "duration_s": 12,
  "clock_status": "synced",
  "clock_offset_ms": 8,
  "presence_state": "present",
  "collection_state": "completed",
  "observations": {
    "shape": {
      "value": "normal",
      "confidence": 0.76,
      "source": "adapter",
      "model_version": "mlx90640-shape-0.1"
    },
    "color": {
      "value": "yellow",
      "confidence": 0.82,
      "source": "adapter",
      "model_version": "as7341-color-0.1"
    },
    "odor": {
      "value": "moderate",
      "confidence": 0.71,
      "change_pct": 31.2,
      "source": "adapter",
      "model_version": "bme688-odor-0.1"
    }
  },
  "temperature_c": 24.8,
  "humidity_pct": 63.1,
  "quality": {
    "overall_confidence": 0.76,
    "reasons": []
  },
  "member_candidates": []
}
```

## 数据边界

- 传感器分类是健康观察信息，不构成疾病诊断。
- `odor.change_pct` 表示相对设备参考值的变化，不是医学浓度。
- 温湿度表示传感器环境，不直接用于人体健康解释。
- 低置信度或采集不完整的样本会被标记为不可可靠评估。
- 未经成员认领的数据不会进入个人趋势。
- 原始数据仅在专项授权的目的、类型和保留期限内使用。
- 公开示例必须使用模拟或去标识化数据。

`sample_data/bme688-demo.bmerawdata` 为 BME688 演示数据，用于开发和接口验证。
