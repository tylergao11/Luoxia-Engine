# Luoxia Engine

Luoxia Engine 是一个始终联网、服务端权威、内容包驱动的 AI 世界平台。

平台固定包含：

- **World Core**：世界图、规则、模型编排、存档，以及唯一权威入口 `apply_packet`；
- **System**：Director 的玩家专属常驻模式，负责目标解析、可行路径导航与世界缺口补全；
- **GDJS Runtime**：固定版本的场景、动画、状态机、音效与舞台运行库；
- **ContentBundle Loader**：校验并加载外部、版本化、不可变的 ContentBundle JSON；
- **Materialization Pipeline**：把运行时新实体与新定义绑定为持久视觉资产。

核心承诺：玩家提出符合世界基本规则的目标，而世界没有预设入口时，Director 的 System 模式会依据现有规则回复、规划或补全最小世界入口。System 可以修路，但不替玩家走路，也不免费创造结果。

事件权限固定为：只有 Director 拥有事件调用上下文并能提出事件；System 只是 Director 的一个模式。RulePlugin 只裁决，只有 World Core 可以通过 `apply_packet` 把结果变成世界事实。EventCard 在发出时完成裁决、结果封存与 AP 扣除，点击时只校验前置条件并应用封存结果。

当前设计阶段直接使用外部 ContentBundle JSON：内容作者与内容 Agent 按 [`contracts/content-bundle.v1.schema.json`](contracts/content-bundle.v1.schema.json) 编写，Engine 校验后加载并按 digest 锁定。暂不建立 Excel、CSV 或内容编辑器编译链；未来若增加策划工具，它也只能生成同一份 ContentBundle JSON，不能成为第二真相。

当前仓库已进入可编译骨架阶段。架构边界见 [`docs/architecture.md`](docs/architecture.md)，运行时精确 JSON 形状仍以 [`contracts/`](contracts/) 中的 Schema 为唯一真相。

## 当前骨架

```text
contracts/
packages/contracts-runtime/   Schema Registry、RFC 8785 摘要、ContentBundle 边界
packages/world-core/          唯一 apply_packet 门面与组合入口
apps/server/                  Model/RulePlugin 网关、在线服务入口
apps/gdjs-host/               JSON Bridge 与 StageModule 端口
```

- 七份 Draft 2020-12 Schema 在服务启动时统一加载并解析引用；未知合同、非法输入与关联字段不一致都会明确失败。
- ContentBundle Loader 只接受纯 JSON，核对 `release.bundle_digest` 后再进入必须注入的语义门禁；没有 Excel、编译器字段或兼容入口。
- World Core 对普通调用方只暴露 `applyPacket`；语义校验器与原子事务存储只能从组合入口注入，门禁和提交在同一锁定快照内顺序执行，不存在直接写 WorldState 的公共服务。
- ModelGateway 与 RulePluginGateway 只接收通过 Schema 的消息，并校验请求、响应、摘要、锁与确定性上下文的关联关系。
- GDJS Host 只收发通过 Bridge Schema 的 Envelope；StageModule 通过窄接口组合，不继承引擎基类，也没有 WorldState 写权限。
- 当前尚未提供数据库、EffectOp executor、具体 RulePlugin、模型 Provider、内容包或 GDJS 实现；这些必须按已锁定端口继续实现，禁止临时内存真相或默认兜底。

## 启动骨架服务

运行时锁定 Node.js 24 LTS。

```powershell
npm install
npm run build
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000
```

启动后可访问 `GET /api/health`。`--contracts`、`--host`、`--port` 均为必填配置，进程不会猜测默认值。
