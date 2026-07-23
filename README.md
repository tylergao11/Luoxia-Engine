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

当前仓库处于合同设计阶段。架构边界见 [`docs/architecture.md`](docs/architecture.md)，运行时精确 JSON 形状以 [`contracts/`](contracts/) 中的 Schema 为唯一真相。
