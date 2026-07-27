# Unity Host 设计树指针（非 Engine 真相源）

## 位置

1. **兄弟根（正式 Host 落点）**：`join(parent(Luoxia-Engine), "Luoxia-Unity")`
2. **仓库内镜像（审计可见）**：`.agents/unity-host-design/`

两处均为设计产物 only；无 Unity Project、无 C# 实现、无 contracts 修改。

## 索引

- `HOST_LAYOUT.md` — 路径无关兄弟布局
- `config/host.example.json` — 配置键（无默认 URL/绝对路径）
- `docs/bridge-message-map.md` — Client/Server 消息全表
- `docs/codex-handoff-gaps.md` — Codex 缺口 Gap-1…11
- `docs/state-ownership.md` — 状态所有权
- `docs/contracts-consumption.md` — Schema 消费
- `docs/delivery-checklist.md` — 核验清单
- `src/Luoxia.*/README.md` — 模块职责占位

本文件不是 `contracts/` / `architecture.md` / `README.md` 真相源的一部分。