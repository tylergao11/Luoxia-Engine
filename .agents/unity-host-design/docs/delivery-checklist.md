# 交付核验清单（本 plan）

核验时点：设计树落盘后。  
路径规则：只描述兄弟关系；不把盘符写入推荐默认。

## Success Criteria

| 标准 | 结果 | 证据 |
|------|------|------|
| 兄弟目录解析规则可复现、无盘符常量 | **通过** | `HOST_LAYOUT.md` 算法；`config/host.example.json` 仅 sibling 名 |
| Client/Server 消息映射覆盖 schema 全部 type | **通过** | `bridge-message-map.md`：Client 10 + Server 10 均出现 |
| Codex 缺口含 Schema 锚点 + Unity 场景 | **通过** | `codex-handoff-gaps.md`：Gap-1 … Gap-11 |
| 状态所有权可指导 U3/U4 | **通过** | `state-ownership.md` |
| Engine 业务树无 contracts/server 变更 | **通过** | `git status -- contracts apps/server packages` 空 |
| 未创建 Unity ProjectVersion / 未装包 | **通过** | 无 `ProjectSettings/`、无 `.csproj`、无 `Packages/` |

## 产物树

```text
Luoxia-Unity/
  HOST_LAYOUT.md
  README.md
  config/host.example.json
  docs/
    bridge-message-map.md
    codex-handoff-gaps.md
    contracts-consumption.md
    state-ownership.md
    delivery-checklist.md
  src/Luoxia.{Contracts,Transport,Session,Dialogue,Presentation,Stage,Assets,UnityHost}/README.md
```

## 本机一次性探针（非默认配置）

解析关系（名称级）：

```text
workspace_parent = parent(Luoxia-Engine)
sibling(Luoxia-Unity) exists = true
sibling(Luoxia-Deployment) exists = false  (仅预留名，本阶段不创建)
```

具体盘符因机器而异，**不得**抄进 host 配置默认值。

## 明确未做（符合 plan 非目标）

- 未改 Engine contracts / Server
- 未创建 Unity Editor 工程
- 未写可编译 C#
- 未 git commit / push

## 下一步（plan 外）

1. Codex 回复 `codex-handoff-gaps.md` 优先问题（尤其 Gap-1 Session 引导）
2. 本机安装 Unity Editor 后开 U2
3. 部署侧恢复 `Luoxia-Deployment` 兄弟根后再做 U3 真联调
