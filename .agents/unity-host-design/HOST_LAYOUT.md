# Luoxia Host 布局约定（路径无关）

本文档属于 **Unity Host 设计树**，不是 Engine 真相源。  
Engine 合同仍以兄弟仓库 `Luoxia-Engine/contracts/*.schema.json` 为唯一机器真相。

## 1. 兄弟根命名

工作区只认 **同一父目录下的并列根**，不认盘符、不认固定绝对路径：

```text
{workspace_parent}/
  Luoxia-Engine/       # Server / World Core / contracts
  Luoxia-Unity/        # Client Host（本树；U2 前可为设计-only）
  Luoxia-Deployment/   # 部署组合根（密钥、内容、Provider；本树不创建）
```

| 逻辑名 | 默认目录名 | 配置键（可覆盖） |
|--------|------------|------------------|
| Engine | `Luoxia-Engine` | `workspace.engine_sibling_name` |
| Unity Host | `Luoxia-Unity` | （本树自身） |
| Deployment | `Luoxia-Deployment` | `workspace.deployment_sibling_name` |

家用机与公司机可以有不同的 `{workspace_parent}`（例如不同盘符），只要三者 **并列** 且名称可配置即可。

## 2. 解析算法（实现时必须遵守）

```text
1. 取得 Host 自身根 host_root（Unity 工程根或本设计树根）
2. workspace_parent := parent(host_root)
3. engine_root := join(workspace_parent, config.workspace.engine_sibling_name)
4. deployment_root := join(workspace_parent, config.workspace.deployment_sibling_name)
5. contracts_dir := join(engine_root, config.workspace.contracts_relative)
6. 任一步路径不存在 → 明确失败，禁止回退到硬编码绝对路径或“猜盘符”
```

禁止：

- 在源码、示例配置、文档推荐值中写死盘符绝对路径作为默认。
- 把 Editor 安装目录、Engine 仓库内部当作 Host 根。
- 用环境变量偷偷注入绝对路径默认值（允许显式覆盖 sibling **名称**）。

允许：

- 本机探针日志打印一次解析后的绝对路径（仅诊断，不写入配置文件默认值）。
- 部署包内嵌 **已 digest 锁定** 的 contracts 副本（见 `docs/contracts-consumption.md`）。

## 3. 本树当前阶段内容

| 路径 | 职责 |
|------|------|
| `HOST_LAYOUT.md` | 本文件 |
| `config/host.example.json` | Host 配置键示例（无生产默认 URL） |
| `docs/` | Bridge 映射、状态所有权、Codex 缺口、contracts 消费 |
| `src/*/` | 未来 asmdef 模块占位（无 `.cs` / 无工程文件） |

**本阶段不是 Unity Project**：无 `ProjectSettings/`、无 `Assets/`、无 `Packages/manifest.json`。  
正式工程创建属于任务书 **U2**，且须在本机有 Editor 并显式锁定版本之后。

## 4. 与 Engine 的边界

```text
Luoxia-Engine/contracts  ──只读──►  Luoxia-Unity (校验与路由)
Luoxia-Engine/apps/server ──HTTP──►  Host Transport（显式 base_url）
Host  ──X──►  World Core / PostgreSQL / 私改 Schema
```

Grok（Host）发现合同不足时：只在 `docs/codex-handoff-gaps.md` 报告，**不** 在 Host 发明字段，**不** 修改 Engine 合同。
