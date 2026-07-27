# Contracts 消费策略（禁止第二真相）

## 1. 唯一机器真相

```text
兄弟 Luoxia-Engine/contracts/*.schema.json
```

Host **不得**：

- 复制一份可手改的“私有 schema”并与 Engine 分叉；
- 用 `JsonUtility` / 手写 C# DTO 字段列表 **替代** Schema 校验；
- 按 `pack_id`、世界名、人物名写协议分支。

Host **可以**：

- 在内存中持有已通过 Schema 验证的不可变 JSON 文档视图；
- 用闭合 `switch (type)` / discriminator map 路由（类型字符串来自 Schema const）；
- 在发布物中嵌入 **与某次 Engine 发布 digest 锁定一致** 的 schema 文件副本（只读资源）。

## 2. 开发期解析（路径无关）

见 `HOST_LAYOUT.md`：

```text
contracts_dir = join(parent(host_root), engine_sibling_name, contracts_relative)
```

加载至少：

- `common.v1.schema.json`
- `client-bridge.v1.schema.json`
- `world-runtime.v1.schema.json`
- （资产相关）`materialization.v1.schema.json`

校验入口建议（U3 实现时）：

- 入站：每个 `ServerEnvelope` 相对 `ServerEnvelope` / 整包 oneOf 校验通过后，再读 `message.type`。
- 出站：每个 `ClientEnvelope` 发送前校验。

失败 → 不进入业务路由。

## 3. 发布期

部署流水线应从 **同一 Engine 提交或正式 release** 拷贝 contracts，并记录：

- Engine git 修订或 release 标签（部署配置，非 Host 硬编码）；
- 可选：目录级 digest（部署侧计算）。

Host 启动时若嵌入 schema 与期望 digest 不一致 → fatal。

## 4. JSON Schema 方言

- 方言：JSON Schema **Draft 2020-12**（各 schema 文件 `$schema` 字段）。
- 需要：`$ref` 跨文件、`$defs`、`oneOf`、`const`、`additionalProperties: false` 等。
- U2/U3 选型 C# 库时以 **完整通过 Engine 七份 schema 加载** 为门禁；不在无 Editor 阶段锁定 NuGet 版本。

## 5. 与 `@luoxia/contracts-runtime` 的关系

Engine 包依赖方向（AGENTS）：

```text
unity-host → contracts-runtime/portable   （概念边界）
```

今日 **无** 可引用的 Unity 预编译 portable 程序集交付物。  
v1 Host 策略：

1. 直接消费 **JSON Schema 文件**（本策略）；  
2. 不把 TypeScript `ValidatedJson` 实现搬进 C# 作为第二运行时；  
3. 若未来 Codex 发布正式 portable 校验库，再评估替换，仍以同一 schema 文件为真相。

## 6. 配置中的 contracts 键

`config/host.example.json`：

```json
"workspace": {
  "engine_sibling_name": "Luoxia-Engine",
  "deployment_sibling_name": "Luoxia-Deployment",
  "contracts_relative": "contracts"
}
```

无绝对路径；无默认 Server URL。
