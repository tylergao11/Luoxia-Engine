# Luoxia Engine

Luoxia Engine 是一个始终联网、服务端权威、由外部内容包驱动的 AI 世界引擎。

它不是命令行游戏，也不把玩家的自然语言当作通用行动指令。玩家通过 Unity GUI 选择地图、对话、计划、EventCard、Stage 与结束当天；自由文本只表示玩家对已选 NPC 或 System 说的话。System 可以解释目标、规划路径和补全世界入口，但不替玩家行动，也不绕过世界规则创造结果。

## 当前交付状态

仓库中的非 Unity Engine 已形成无头闭环：

- `contracts/` 是全部运行时 JSON 字段、枚举与消息形状的唯一机器真相；
- Content Runtime 校验、锁定并索引部署显式提供的外部 ContentBundle；
- World Core 通过唯一 `apply_packet` 入口执行闭合 EffectOp，拥有状态机、事件卡、目标、Stage、账本与当前 VisualBinding 等世界状态变换；
- Server Runtime 拥有世界创建、存档导入导出与迁移、Session、Command Journal、日循环、对话、地图移动、EventCard、Stage outcome、Content Upgrade 与 Materialization 编排；
- PostgreSQL 18.x 分字段保存运行时唯一事实；Journal、CommittedEvent 与 Materialization Ledger 提供幂等恢复和外部调用证据；
- 各类闭合模型职责保持隔离，Provider 只接收最小语义投影；完整请求、关联证据与使用量仍由 Server Journal 拥有；
- RulePlugin、模型、客户端、StageModule 与资产 Provider 只能提出经过合同校验的结果，均不能直接写 WorldState；
- Client / Stage Bridge 的服务端合同与投影已实现，打开的 Stage 不阻止结束当天。

当前公共合同采用预发布干净切换，不读取旧字段、旧存档或旧数据库形状，也不提供兼容旁路。

## 尚未包含

- 本仓库没有 Unity Host、Unity UI、3D Stage 本地实例化、资源下载缓存或逐帧交互；这些由外部 Unity 工程实现。
- 本仓库不内置具体世界内容、RulePlugin 制品、StageModule 制品、数据库实例、模型账户/密钥、Materialization 执行者或部署默认值。
- 没有真实部署制品时，只能证明 Engine 的构建与无头边界，不能声称内容专属的模型、资产或 Stage 端到端运行。

## 真相源与目录

| 路径 | 唯一职责 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Agent 工作约束 |
| [`contracts/`](contracts/) | 运行时 JSON 机器合同 |
| [`docs/architecture.md`](docs/architecture.md) | 产品不变量、架构边界、所有权与权威数据流 |
| `packages/contracts-runtime/` | Schema Registry、摘要与合同语义门禁 |
| `packages/world-core/` | 内容无关的世界规则与唯一 `apply_packet` 门面 |
| `apps/server/` | 在线编排、Journal、PostgreSQL adapter 与部署入口 |
| 外部 ContentBundle JSON | 具体世界、人物、剧情、规则语义与美术内容 |

README 只维护项目入口、当前能力和真实缺口。精确字段以 Schema 为准；接口职责与数据流以架构文档为准。

## 构建与健康检查

要求 Node.js `^24.18.0`。

```powershell
npm install
npm run build
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000 --mode=health
```

启动后访问 `GET /api/health`。`--contracts`、`--host`、`--port`、`--mode` 都必须显式提供。

## 真实运行模式

运行模式必须指定一个绝对路径的受信 deployment module：

```powershell
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000 --mode=runtime --deployment-module=C:\absolute\luoxia-deployment.mjs
```

deployment module 导出异步 `createLuoxiaRuntimeDeployment({ contracts, digest })` 并返回 `{ activation, close }`。它通过 `@luoxia/server/deployment-api` 显式提供数据库 Pool、内容包、RulePlugin、StageModule、迁移制品、Provider、密钥与版本配置；Engine 不扫描目录，也不猜测任何部署值。

该 HTTP 模式提供 `GET /api/health` 与 `POST /api/client-envelope`。世界创建、存档管理和 Session 打开属于可信管理面，由部署应用通过 deployment API 接入，不暴露匿名旁路。

## PostgreSQL 初始 DDL

应用不会自动建表或运行 migration。全新空库由部署流程执行：

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/server/migrations/0001_atomic_packet_store.sql
```

该文件是空数据库的完整初始 DDL，不是可重复执行的升级脚本。已有部署必须提供与自身准确源状态匹配的显式迁移，或在确认无需保留数据后重建；Engine 不同时维护新旧表形状。
