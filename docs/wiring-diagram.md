# 系统连接图

```mermaid
flowchart LR
    BME[BME688] -->|传感器总线| ESP[ESP32]
    APDS[APDS9960] -->|传感器总线| ESP
    MLX[MLX90640] -->|传感器总线| ESP
    AS[AS7341] -->|传感器总线| ESP
    ESP -->|USB Serial| ADAPTER[MacBook / Edge Device\nPython Adapter]
    ADAPTER -->|Session JSON / HTTP| API[PoopSense FastAPI]
    API --> DB[(SQLite / PostgreSQL)]
    UI[React / PWA 前端] <-->|HTTP| API
    API --> AGENT[Agent 与安全仲裁]
    AGENT --> ROBOT[机器人 Tooling]
    ROBOT -->|USB / CAN / SDK| CTRL[Panthera 控制箱]
    CTRL --> ARM[六轴机械臂与夹爪]
    ROBOT -->|HTTP Bridge / ROS 2| VBOT[VBot 路线控制器]
    ROBOT -->|设备接口| REMINDER[提醒机器人]
    ARM -->|状态 / 结果| ROBOT
    VBOT -->|到站 / 异常| ROBOT
    REMINDER -->|状态 / 结果| ROBOT
    ROBOT -->|任务结果| API
```

## 感知器接线与数据流

- BME688、APDS9960、MLX90640 和 AS7341 连接至 ESP32；具体引脚、电压和总线地址以展机实际原理图及模块规格为准。
- ESP32 负责一次采集流程的开始、传感器读取、基础预处理和串口发送。
- ESP32 通过 USB Serial 与 MacBook/边缘设备连接。
- Python Adapter 完成数据解析、特征提取、分类、质量评估和 JSON 封装，再通过 HTTP 发送至 PoopSense 后端。

## 执行设备接线

- 上位机运行 PoopSense 后端、机器人 Tooling 和机械臂 Host。
- Panthera 控制箱通过 USB/CAN 与上位机通信，并为关节提供控制链路。
- VBot 通过命名路线接口接收启动、状态和停止请求。
- 提醒机器人通过其设备接口接收推水和语音提示任务。
- 电机与控制设备必须共用明确的急停/断电流程；调试时保持低速并清空安全区域。
- 各硬件数量和用途以 [`bom.csv`](bom.csv) 为准。
