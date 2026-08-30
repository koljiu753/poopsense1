# Demo 演示说明

## 演示前准备

- 固定 PoopSense 感知器、VBot、机械臂和水杯位置。
- 检查 BME688、APDS9960、MLX90640、AS7341 与 ESP32 的供电和连接。
- 确认 ESP32 USB Serial 已被 Python Adapter 识别，能够生成 Session JSON。
- 清空机械臂和 VBot 周围安全区域。
- 检查机械臂控制箱、电源、USB/CAN 和夹爪连接。
- 确认 VBot 已加载现场使用的命名路线。
- 准备急停或快速断电方式。

## 启动软件

首次安装：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
Copy-Item .env.local.example .env.local

cd ..\frontend
npm ci
```

开始演示：

```powershell
cd ..
.\start_demo.ps1
```

打开 `http://127.0.0.1:5173/`。

## 推荐演示顺序

1. 展示 PoopSense 感知器中的四类传感器、ESP32 和家庭使用场景。
2. 展示接近触发、串口数据和 Python Adapter 生成的 Session JSON。
3. 在待认领箱选择家庭成员。
4. 展示动画反馈、个人趋势和 Agent 分析。
5. 展示补水建议、安全检查和用户确认。
6. 执行机械臂取杯和提起动作。
7. 执行 VBot 预设路线。
8. 执行机械臂递水动作。
9. 用户扶稳水杯并确认，机械臂松爪后返回待机位。
10. 展示任务结果、Agent Action 和家庭长期记忆。

## 演示口径

> PoopSense 通过“主 Agent＋专业 Agent＋长期记忆＋Tooling”将家庭健康感知转化为现实行动。机器人动作采用安全可控的固定示教点位与 VBot 预设路线，关键动作均经过实机验证，并由统一任务状态机记录阶段和结果。
