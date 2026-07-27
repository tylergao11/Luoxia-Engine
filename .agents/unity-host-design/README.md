# Luoxia-Unity（设计树 / 未来 Host 根）

本目录与 `Luoxia-Engine`、`Luoxia-Deployment` **并列**，不嵌入 Engine 仓库。

| 阶段 | 状态 |
|------|------|
| 当前 | 设计产物 only：布局、配置示例、Bridge 映射、Codex 缺口、状态所有权 |
| 非当前 | Unity Project（`ProjectSettings` / `Assets` / Package 锁）→ 任务书 U2 |
| 禁止 | 假 Server、硬编码盘符路径、私改 Engine Schema |

## 文档索引

| 文件 | 用途 |
|------|------|
| [HOST_LAYOUT.md](HOST_LAYOUT.md) | 兄弟根解析，路径无关 |
| [config/host.example.json](config/host.example.json) | 配置键示例 |
| [docs/bridge-message-map.md](docs/bridge-message-map.md) | 全部 Client/Server 消息映射 |
| [docs/codex-handoff-gaps.md](docs/codex-handoff-gaps.md) | 交 Codex 的合同/接缝缺口 |
| [docs/state-ownership.md](docs/state-ownership.md) | 谁拥有什么状态 |
| [docs/contracts-consumption.md](docs/contracts-consumption.md) | Schema 消费与反第二真相 |

## 未来模块（`src/` 占位）

见各子目录 `README.md`。U2 再创建 asmdef 与 C# 实现。
