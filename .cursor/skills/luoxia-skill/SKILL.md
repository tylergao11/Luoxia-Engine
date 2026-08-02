---
name: luoxia-skill
description: >-
  Routes Luoxia (落霞) Engine/Deployment/Unity work: design and方案定案 via Fable 5,
  implementation via Grok 4.5 High Fast. Use when the user mentions Luoxia,
  Luoxia-Skill, 落霞, 孤烟渡, Guyandu, ContentBundle, EventBudget, client-envelope,
  Unity Host, or精品 MVP polish across Luoxia-Engine / Luoxia-Deployment / Luoxia-Unity.
---

# Luoxia-Skill

落霞三仓协作技能。先定案再落盘；模型分工不可混用。

## Repos

| Repo | Path | Owns |
|---|---|---|
| Engine | `C:/Ai/Luoxia-Engine` | contracts, world-core, server, architecture |
| Deployment | `C:/Ai/Luoxia-Deployment` | Guyandu/Riverside content, provision, RulePlugin |
| Unity | `C:/Ai/Luoxia-Unity` | Client Bridge, immersion UI, hash art |

真相源优先级：各仓 `AGENTS.md`（若有）→ Engine `docs/architecture.md` → `contracts/*.schema.json` → 外部 ContentBundle JSON。字段只改 Schema；架构责任变化才改 architecture；启动/能力变化才改 README。

## Model routing（强制）

| 工作类型 | 谁做 | 怎么开 |
|---|---|---|
| 设计 / 定方案 / 剧情语义 / Prompt 措辞 / 预算节奏 / 否决与取舍 | **Fable 5 Max** | 聊天窗选手动 **Fable 5 Max**（Thinking On，Effort **Max**）。若必须 `Task` 子代理：`model: claude-fable-5-thinking-xhigh`（当前子代理最高档=Extra High，**低于** UI Max；定案级优先开 Max 窗，勿假装 Task 能拉 Max） |
| 主力执行 / 接线 / 改代码 / 生成 bundle / build / health | **Grok 4.5 High Fast** | `Task` 用 `model: cursor-grok-4.5-high-fast`；或聊天窗选手动同名模型 |

规则：

1. 未定案前，Grok **不得**改剧情文案、Prompt 语义、日容量/镖期故事语义、outcome 词表。
2. 已定案后，Grok 只按定案落盘；不得借机重设计。
3. Fable **不得**大面积改 Engine/Server/Unity 实现，除非用户明确要求它写代码。
4. 父代理若是 Auto：设计阶段拉 Fable 子代理（或请用户切 Max 窗）；执行阶段拉 Grok 子代理。
5. 向用户提及时用 UI 名（Fable 5 Max / Grok 4.5 High Fast），不要只甩 kebab slug。

## 工作流

1. **读约束**：Engine `AGENTS.md` + 相关 Schema/architecture 片段；禁止测试工程、硬编码内容名进 Engine/Unity、第二套协议模型、默认/兜底、任意写世界。
2. **判类型**：
   - 方案/节奏/剧情/Prompt/「是否合理」→ Fable 定案（输出要可执行：改哪些文件、改成什么）。
   - 明确「按方案实现 / 接线 / build」→ Grok 执行。
   - 混合任务 → 先 Fable 一段定案，再 Grok 执行；中间向用户亮出定案要点。
3. **执行（Grok）**：
   - 先 `git status` 保护既有修改。
   - 内容只进 Deployment；Engine/Unity 只认合同与 hash。
   - 改完：`npm run build`；改了 Server 再 `GET /api/health`；`git diff --check`；bundle 变更后重启 Engine + provision 对齐 digest。
   - 不建 `tests/`；不自动 commit/push。
4. **交卷**：改了哪些文件、已证明什么、下游未接什么；停止。

## 产品硬规则（落霞已定）

- 对话与 EventCard 一体：`EventBudget.remaining === 0` 拒绝对话，玩家只能 `player_day.end`。
- 成功对话必走 `director.dialogue_events`，恰好 1 张有世界影响的卡；禁止空卡、禁止没点数白嫖 Token。
- 孤烟渡节奏基线：日容量 **4**；盐镖 `salt_convoy` 日结推进（筹备→启程→过境→已过）；错过是分叉不是 Game Over。
- 玩家自由 = 点数/措辞/承诺/开卡/走位养结局；世界钟表自动走。

## 包边界

```text
contracts-runtime → contracts
world-core → contracts-runtime/portable
server → world-core + contracts-runtime
unity-host → contracts-runtime/portable
```

- World Core 禁止 DB/HTTP/Provider/Unity/具体内容。
- Unity 禁止 import World Core。
- ContentBundle 不得带 EffectOp / WorldState 写入 / 模型密钥。

## 触发词

用户说「Luoxia-Skill」「落霞」「按 Luoxia 技能」「精品 MVP」或在上述三仓做设计/实现时，必须遵循本技能。
