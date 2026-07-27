# Host 状态所有权

防止 Unity 本地缓存变成第二套世界真相。

## 1. 只属于 Server（Host 不得当权威源）

| 状态 | 说明 |
|------|------|
| WorldState / Entity / Relation / Component | Host 永不读写 |
| 规则、AP、关系、剧情结算 | 仅 Server + apply_packet |
| NPC / System 台词权威集合 | `SessionView.dialogues`（及同 revision 投影） |
| `basis_token` 的密码学含义 | Host 只保存 **最新下发的不透明字符串** |
| ServerEnvelope `message_id` / `sequence` 分配 | 检测 gap，不重编号 |
| Command 最终结果 | `command.result` + Journal 幂等 |
| EventCard 封存结果 | 点击只 trigger，不重算 |
| 全局 / 隐藏 world revision | 客户端不拥有泄密游标 |

## 2. 只属于 Unity（可丢弃，resync 可重建）

| 状态 | 说明 |
|------|------|
| 客户端 envelope `sequence` 游标 | 出站单调 |
| 连接状态、HTTP 飞行中请求 | Transport |
| 未完成 UI 动画 / 音频播放进度 | 表现层 |
| GameObject 实例、对象池 | 按稳定 render_node / stage id 关联 |
| Stage 本地表现状态机 | 可被 StageClose 或重连丢弃 |
| 资产字节缓存 | 以 content digest 校验；旧 revision 不得覆盖新 binding |
| 本地“正在输入”草稿文本 | 发送前可丢 |
| correlation 等待表 | UI 关联 |

## 3. 共享但单向的令牌

| 数据 | 写入者 | Host 规则 |
|------|--------|-----------|
| `session_id` | Server / 网关 | 配置注入后只读 |
| `basis_token` | Server（SessionView / delta） | 每次更新覆盖；命令只带最新值 |
| `view_revision` | Server | 全量替换或严格 delta |
| `command_id` | Host 生成 | 同一动作重发 **禁止** 换新 ID |
| `dialogue_id` | Server（start 结果 / view） | continue 必须用服务端 id |

## 4. 对话双通道规则

```text
dialogue.reply  →  低延迟 UI 提示（可显示单 turn）
session.view    →  同 view_revision 下 dialogues[] 为最终集合
```

- 禁止 UI 在收到 reply 前插入“假 NPC 回复”。  
- 同 command 重放不得因 reply + view 各画一次而 **重复 turn**（按 turn 稳定身份去重，身份来自 Schema 字段，不发明）。  
- 不显示 model request id、output digest、commitment、隐藏 dialogue revision。

## 5. SessionView / Delta

| 消息 | 规则 |
|------|------|
| `session.view` | 不可变快照全量替换；丢弃未应用 delta 缓冲 |
| `session.delta` | 要求本地 revision == `base_view_revision`；更新到 `view_revision` 并替换 `basis_token` |
| 失败 | 发 `session.resync_request`（Server 就绪后）或展示 protocol 错误；**禁止** 猜补字段 |

## 6. 断线与重放

1. 飞行中 command：**保留** `command_id` 与完整 message 正文摘要。  
2. 重连后用 **同一** command_id + 正文重发（Server Journal 幂等）。  
3. 不得把“用户又点了一次”自动变成新 command_id 除非用户明确新动作。  
4. sequence gap / 未知 type / 未知 protocol → 明确失败（`protocol.error` 或本地 fatal），不降级 `no_effect`。

## 7. Stage

| 消息 | 本地效果 |
|------|----------|
| `stage.open` | 创建实例；记录 allowed_input_types |
| `stage.update` | 只改 visible_state |
| `stage.input` | 提交意图，不写世界 |
| `stage.outcome_proposal` | 提案 only |
| `stage.close` | 幂等销毁；重连可丢弃后由 Server 再建 |

动画/镜头/音效 **禁止** 反向写 WorldState。

## 8. 资产

- 只消费 `asset.binding` / StageOpen.bindings。  
- 校验 AssetContentRef 的 content digest。  
- 缺失：合同允许的 pending/fallback；不生成世界事实。  
- 旧 binding 结果不得覆盖新 revision。
