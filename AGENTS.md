# Agent 约束

## 禁止

- **禁止测试工程**：不得创建 `tests/`、`test_*`、pytest、jest、vitest、测试夹具或冒烟脚本。验证只运行现有构建、一次性只读 JSON/Schema 校验、静态检查与人工试用；验证代码不得提交进仓库。
- **禁止硬编码内容**：World Core、协议、GDJS Host 不得出现具体世界名、人物名、剧情、功法、地点、货币或内容包分支。协议版本、闭合的通用 `EffectOp`、错误码与安全上限属于引擎合同，不属于内容硬编码。
- **禁止第二真相**：每类事实只能有一个正式所有者。外部内容包直接维护的 ContentBundle JSON 是当前唯一内容源；缓存、索引、转换结果与文档不得反向成为源文件。
- **禁止内容越权**：ContentBundle JSON 可以引用公开内容合同，但不得携带 EffectOp、WorldState 写入、模型供应商配置、GDJS 内部对象或存档迁移命令。
- **禁止旧项目迁移**：不得依赖或复制 QingYun、LuoXia、GameCastle 的业务代码、对象模型、兼容层或存档格式。GDJS 使用固定的官方运行时；旧仓库只可作为设计经验来源。
- **禁止重复门禁**：同一份未变化的产物不得反复全量验证；不得把每次措辞或局部调整升级成完整交付审计。

## 真相源

| 路径 | 唯一职责 |
|---|---|
| `AGENTS.md` | Agent 工作约束 |
| `README.md` | 项目入口与当前交付状态 |
| `docs/architecture.md` | 架构边界、权威流与合同所有权 |
| 外部 ContentBundle JSON | 各内容包自己的世界、角色、剧情、规则语义与美术内容；不存放在引擎仓库 |
| `contracts/*.schema.json` | 运行时 JSON 字段、枚举与消息形状的唯一机器真相 |

新增说明必须更新上述现有真相源，不创建临时计划、会话备忘、重复架构文档或测试报告文件。

## 接口纪律

- Content Pack 只依赖公开合同；World Core 不反向 import 具体内容包。
- 引擎只按 `contracts/content-bundle.v1.schema.json` 校验并加载外部 ContentBundle JSON；当前不维护 Excel、CSV、ContentDesignIR 或内容编辑器转换链。
- 模型、RulePlugin、StageModule、GDJS、客户端与资产流水线都不能直接写 World State。
- `apply_packet` 是唯一权威写入口，只接收验证后的 `ContentPacket`，整包原子提交或完整拒绝。
- `ContentPacket` 只含前置条件、确定性输入与闭合 `EffectOp`；唯一例外是 `EventCardPublishOp` 内经裁决封存的惰性 `EventResultPresentation`，且 NPC 原话只能引用既有 `DialogueTurn`。它不参与规则求值；资产路径与 GDJS 指令不得混入。
- RulePlugin 的 `operation_kind` 是唯一入口真相；每个 kind 都有闭合输入、输出与 allowed-op 子集，禁止通用 PacketProposal 旁路。
- 客户端只消费 SessionView 与表现消息，不读取隐藏世界真相，不按 `pack_id` 写内容分支。
- 外部输入与模型输出一律视为不可信 JSON，先做 Schema 与语义校验。

## 轻量工作流

- 设计阶段先对齐决策，不把每次讨论或小改都当成交付里程碑。
- 一个稳定里程碑只做一次与风险相称的总体验证；后续小改只检查受影响部分。
- 普通、可逆、低风险工作允许 Writer 自检，不强制独立验证 Agent 与独立审计 Agent。
- `sol-os`、多 Agent 双审和 writer/test/audit 接力不是默认流程；仅在用户明确要求，或存在安全、数据损坏、不可逆迁移、外部发布等具体高风险时启用。
- 若检查发现问题，修复后只复查问题及其直接影响面；只有核心合同整体变化才重新做一次总验。
- 已有充分证据即可停止，不为流程完整感继续重复检查。
- 不新建测试工程，验证证据留在任务输出，不写入仓库。
