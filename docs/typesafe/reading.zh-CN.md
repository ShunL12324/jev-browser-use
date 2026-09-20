# TypeSafe / Jev 全站阅读笔记

阅读日期：2026-09-20。以官方 [llms.txt](https://docs.typesafe.ai/llms.txt) 和 [sitemap](https://docs.typesafe.ai/sitemap.xml) 交叉核对，109 个页面集合一致，正文、内嵌示例代码和输出已逐页读完。包括概念、原语、架构模式、演示说明、Python/JavaScript SDK 全部参考页、HTTP API、模型限制、Agent skill、Legal 入口及 18 篇 Cookbook。

[逐页清单与要点](pages.zh-CN.md)；[来源、页面指纹与覆盖记录](coverage.json)。没有执行 Cookbook、播放视频、逐张视觉核验图片或递归阅读外站链接。没有为此次阅读调用收费推理 API。这里区分官方接口事实、示例做法和对本项目的推断。

## 1. 实际调用模型是什么样

公开接口是 `POST /v1/systemone`，主要输入为 `model + state + questions`，输出为按问题 ID 对应的 `answers`，以及模型、用量信息。[HTTP API](https://docs.typesafe.ai/api)

| 聊天模型中常见的内容 | Jev 接口里的对应安排 |
| --- | --- |
| 系统指令 | 各题的 instructions 与 criteria；不能据此假定具有 system role 的权限层级 |
| 当前输入与上下文 | state，可为文本、对象、数组 |
| 多轮 messages | 没有原生 messages 协议；应用自行把需要的历史放入 state |
| 工具定义及执行 | 通过问题选函数、选参数，宿主程序组装并执行 |
| 自由文本回复 | 当前三类原语不提供自由生成 |

**没有 messages 字段不等于没有上下文。** state 和当前问题就是这次判断的上下文。它不会替应用维护浏览器任务记忆；应用可以保留已有 message 格式作为 state 的一部分，也可以提供目标、页面快照、近期动作结果。无需为了 API 重新发明所有历史记录格式。[State](https://docs.typesafe.ai/concepts/state)

问题 ID 用于程序取答案，不传给模型；不能把判断要求只写在 `questions` 的 key 上。同一请求中的问题独立评估，不能在后一道题里引用本次尚未返回的前一道答案。[Primitives](https://docs.typesafe.ai/primitives)

官方介绍了以原子判断为目标的模型与训练理念，但没有公开足够细节来还原内部网络、训练全过程或推理实现。接口可组合并不意味着程序里的所有复杂判断都已经由模型解决。[AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)

## 2. 三种原语的边界

| 原语 | 适合判断 | 需要注意 |
| --- | --- | --- |
| Choice | 从给定候选中选一个，返回各候选概率 | 每题最多 255 项；最优候选也可能不适用 |
| Noul | 某个明确命题为真的概率 | 不是程度分数，也不是逻辑验证器 |
| Score | 按 2–10 个明确语义等级评分 | score 是等级索引的概率加权期望，不是任意数值生成器 |

来源：[Choice](https://docs.typesafe.ai/primitives/choice)、[Noul](https://docs.typesafe.ai/primitives/noul)、[Score](https://docs.typesafe.ai/primitives/score)。

`confidence` 与 `probabilities[choice]` 是不同字段。前者总结分布形状；不能把 0.9 直接解读为这次动作有 90% 成功率。Score 相同期望也可能对应不同分布。多个部件的最低 confidence 可以作为应用路由指标，但不是联合正确概率。[Confidence](https://docs.typesafe.ai/confidence)

## 3. 工具调用与候选爆炸：需要修正先前解释

**官方有完整的 Function Calling Cookbook。** 示例把 10 个普通函数转成题目：函数名用 Choice；Literal 参数用 Choice；布尔值用 Noul；集合参数逐成员用 Noul；可选参数另问是否被明确提到。示例每条指令一次请求 54 题，代码只读取获选函数的相关答案，再调用函数。[Function calling](https://docs.typesafe.ai/cookbooks/function_calling)

因此，“没有 tools 字段”不应被解释成“只能列举完整工具调用字符串”。也不必把动作、元素、键盘修饰键、文本等做笛卡尔积，枚举所有组合。

如果当前观察已经足以构造问题，可以在同一请求预问：选什么动作、点击哪个候选、输入哪个候选值、是否明确给了可选参数。返回后再消费适用分支。这是官方的 [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)。额外问题仍占 token 和额度，只是通常省去往返及重复 state。

当后续候选必须依赖新信息才能构建时，才需要下一轮。例如点击打开新菜单后观察菜单内容；或先拼接文本，再对新生成的块分类。[Structure recovery](https://docs.typesafe.ai/cookbooks/autoformat) 正好展示了真实的数据依赖。

候选来源有几种已展示的方法：

- **已有对象编号。** 给文档行或页面元素 ID，再让 Choice 选 ID；程序保留原始对象。[Line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find)
- **代码预提取。** 正则找出可能的邮箱、数字或金额，Jev 选符合语义的原文片段。名单、NER 或 LLM 也可以提供候选；LLM 并非唯一必选来源。[Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)
- **大集合分层。** 层级分类、beam search、粗排后补充细节；注意粗筛漏掉的对象无法在重排阶段补回。[Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification)、[Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)
- **同时检查是否适用。** Choice 解决相对排名；单独的 exists/fits Noul 或 none 候选防止被迫选一个近似项。二者可能意见不同，最终政策需由代码定义。

开放参数仍有边界：官方 Function Calling 示例没有解决任意文本或任意数字参数，不能直接当成通用 LLM Tool Calling 的等价替代。日期示例是选择年月日等部件，再由代码计算；自由输入文本、URL、脚本及拖动几何仍需已有数据、确定性算法或其他模型提供。[Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)

## 4. 对 browser-use 的具体含义（推断，尚未实现）

现有扩展已经提供 view/snapshot/refs 和动作执行，足以作为实验的观察与执行层。Jev 接口本身不要求我们先构建覆盖所有页面元素的通用语义本体。可以先把已有快照和必要历史交给判断层，逐步测量哪些额外字段确实有帮助。

但是复杂网页的观察、候选召回、状态更新仍是真实工程工作。Canvas、视觉布局、自定义拖拽控件、隐藏状态不会因为 state 接受 JSON 就自动变得可理解。

一个需要验证的边界是：并行选出的动作与参数可能互相不兼容。应用必须检查 ref 是否属于当前 tab/frame、元素是否仍存在、动作是否支持这个元素、必需值是否齐全，再执行并重新观察。针对拖动，可以预先提供源、目标等候选或按源分别问目标；不能把两个独立最高概率答案默认当成合法的一对。当前仓库工具列表也没有独立 drag 工具，决策层不会自动补出执行能力。

目前更合理的结论是：**先评估新增决策适配层，而不是仅凭 state 形式就认定扩展与 MCP 必须底层重写。** 是否要扩充执行层，取决于真实页面任务测试。这里尚未决定最终架构，也未新增 Jev runner。

## 5. 模型及运行限制

按阅读时 [Models](https://docs.typesafe.ai/models) 页面：当前模型为 Jev 1.13.0，latest/preview 是可变化的别名；请求总上限 64k tokens，state 加最大单题为 32k；目前文本输入，不支持直接理解截图、音频、视频。JSON 包裹图片 URL 或 base64 不会赋予视觉能力。

官方 [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) 明确描述了字面理解、计数和算术、编码数值、多跳逻辑、双重否定、长上下文干扰以及提示注入弱点。问题越原子、证据越相关越有利；确定性计算应交代码。state 中的网页内容仍是不可信数据，Jev 判断不能成为权限边界。

Python 与 JS SDK 均提供重试和超时，但语义不同：Python 有总重试预算，JS 文档描述的是每次尝试超时。SDK debug 日志会包含请求/响应正文，header 脱敏不等于 state 脱敏。key 应留在宿主侧。以上是未来接入时的运行设计信息，此次没有修改 SDK 或全局配置。

## 6. 文档差异及示例证据的限度

这些是阅读发现，未用新 API 请求逐项验证：

| 位置 | 差异或限制 | 本项目采用的解释 |
| --- | --- | --- |
| HTTP API 与 SDK 问题类型 | HTTP 表格将 instructions 列为必填，SDK 允许可选/空；state 的 null 类型也不一致 | 初版发送明确非空指令、非空 state；不能只凭 SDK 类型推断服务端接受范围 |
| Structure recovery | 尾段把 confidence 称为胜出项概率，但表格二者分别是 0.43 和 0.53；费用文字与输出也不同 | 字段语义以专门 Confidence/API 页为准，不照搬费用数字 |
| Date extraction | 使用 calibrated confidence 表述 | 不把 confidence 等同于正确率；最小值只是示例路由规则 |
| Hierarchical classification | 叙述称单次请求并行多个路径，展示代码却在线程池中每个路径各发一请求 | 模式支持合批；不能说该代码已经实施合批；路径几何均值不等于联合正确概率 |
| Guardrails 与模型弱点页 | Guardrails 示例措辞容易让人理解为抗注入保证，弱点页明确说明可被注入影响 | 把筛查当信号；RAG Cookbook 也明确说它不是安全边界 |
| SDE cascade | 演示提取结果硬编码；异常 JSON 返回空对象，但逐字段循环只遍历现有字段 | 不能照搬“缺失字段都会触发升级”的结论；应另做结构/必填校验 |
| Python 版本与部分 Cookbook | SDK 0.7 已换 Pydantic，部分示例仍用 msgspec 序列化问题 | 运行前固定版本、改适配并验证；阅读不等于这些示例已在本地跑通 |

相关来源：[HTTP API](https://docs.typesafe.ai/api)、[Structure recovery](https://docs.typesafe.ai/cookbooks/autoformat)、[Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)、[Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification)、[Guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails)、[RAG](https://docs.typesafe.ai/cookbooks/classifying_rag_passages)、[SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)、[Python Changelog](https://docs.typesafe.ai/sdk/python/changelog)。

Cookbook 多数是缓存的 Jev 1.12 实验；个别为 1.13。重复一致性不等于准确率，弃权增加一致性也会减少自动处理覆盖；小样本速度和费用不是我们的浏览器端到端指标。Skill suggestion 甚至展示了错误建议和原本正确的结果被建议带错。[Choice consistency](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)、[Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)

Autoresearch 示例优化的是问题集和下游 CatBoost 特征，而不是在线训练或微调 Jev。它进一步说明：问题设计、候选质量、路由策略和评估集本身都是应用工程的一部分。[Autoresearch feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)
