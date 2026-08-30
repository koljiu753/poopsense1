# 第三方组件说明

PoopSense 是团队从零设计和开发的原创项目。第三方硬件与软件提供基础能力，PoopSense 的产品逻辑、Agent 系统、数据架构、机器人 Tooling、交互和任务流程由团队完成。

## 团队原创部分

- 家庭健康场景、产品定义与交互设计
- 传感数据契约、成员认领和个人趋势体系
- 主 Agent、专业 Agent、Skill、长期记忆与 Soul
- 家庭授权、主动关怀、社区及 Agent 连接
- 确定性安全仲裁和最小授权上下文
- 机械臂/VBot/提醒机器人 Tooling
- 机械臂固定点位标定、成功轨迹及递水状态机
- PoopSense 前端、后端、测试与演示脚本

## 第三方硬件平台

- Panthera-HT 机械臂、Host 与 SDK：HighTorque Robotics。许可证与使用条件以各上游仓库为准。
- VBot 机器狗：用于预设路线导航与具身运输，许可证与使用条件以设备供应方说明为准。
- BME688 气体传感器：Bosch Sensortec；用于气体响应与设备环境温湿度采样。
- APDS9960 接近传感器：Broadcom；用于接近/在场检测和采集状态触发。
- MLX90640 热成像传感器：Melexis；用于低分辨率热阵列与形状特征输入。
- AS7341 颜色传感器：ams OSRAM；用于多通道颜色采样。
- ESP32 开发板：Espressif 平台；用于多传感器读取与 USB Serial 数据传输。
- 传感器模块、控制板、电源和通信模块的许可证与使用条件以各供应商说明为准。

## 第三方软件与服务

- React、Vite、TypeScript、Vitest
- FastAPI、SQLAlchemy、Alembic、Pydantic、pytest
- OpenAI-compatible 模型 API（本地配置，仓库不包含 API Key）

本仓库的 MIT License 仅覆盖团队拥有版权的原创代码，不替代任何第三方组件的许可证、商标或服务条款。
