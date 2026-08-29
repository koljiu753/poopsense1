# 系统连接图

```mermaid
flowchart LR
    SENSOR[PoopSense 感知器] -->|结构化数据| API[PoopSense FastAPI]
    API --> DB[(SQLite / PostgreSQL)]
    API --> AGENT[Agent 与安全仲裁]
    UI[React / PWA 前端] <-->|HTTP| API
    AGENT --> ROBOT[机器人 Tooling]
    ROBOT -->|USB / CAN / SDK| CTRL[Panthera 控制箱]
    CTRL --> ARM[六轴机械臂与夹爪]
    ROBOT -->|HTTP Bridge / ROS 2| VBOT[VBot 路线控制器]
    ROBOT -->|设备接口| REMINDER[提醒机器人]
```

## 展机接线说明

- 上位机运行 Windows、WSL、PoopSense 后端和机械臂 Host。
- Panthera 控制箱通过 USB/CAN 与上位机通信，并为关节提供控制链路。
- VBot 通过命名路线接口接收启动、状态和停止请求。
- 感知器通过结构化事件接口向 PoopSense 后端上报数据。
- 各硬件电源、规格和数量以 [`bom.csv`](bom.csv) 为准。
