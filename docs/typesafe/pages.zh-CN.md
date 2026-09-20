# TypeSafe 逐页阅读清单

阅读日期：2026-09-20。109/109 页；官方 llms.txt 与 sitemap 集合一致。每页均已阅读正文及内嵌代码，短小的 SDK 类型页面也单独列出。原始页面 SHA-256、字节数与地址见 [coverage.json](coverage.json)。

未执行 Cookbook，未播放嵌入视频或逐张视觉核验图片；图表结论依据页面说明、表格与绘图代码阅读。外站法律合同、论文、数据集与 GitHub 源码不计入这个页面总数。页面 UI 组件样板及编码 Playground 链接不作为正文阅读。

| # | 页面 | 阅读要点 |
| --- | --- | --- |
| 1 | [Introduction](https://docs.typesafe.ai/introduction) | 原子判断与代码编排；共用 state 的问题可并行。 |
| 2 | [Quick start](https://docs.typesafe.ai/introduction/quickstart) | 认证、systemone 请求、SDK 与 Playground 入门；不是聊天接口。 |
| 3 | [System One](https://docs.typesafe.ai/concepts/system-one) | System One 定位为非生成式判断组件；复杂流程由代码组合。 |
| 4 | [State](https://docs.typesafe.ai/concepts/state) | state 支持文本、对象、数组；无固定业务 schema，当前只接收文本信息。 |
| 5 | [Primitives (Questions)](https://docs.typesafe.ai/primitives) | 问题 ID 不给模型看；含义须写进 instructions，单次问题彼此独立。 |
| 6 | [Choice](https://docs.typesafe.ai/primitives/choice) | Choice 单题最多 255 项；名称与描述参与判断，应覆盖相关候选并考虑 none。 |
| 7 | [Score](https://docs.typesafe.ai/primitives/score) | Score 2–10 级，返回等级索引的期望；每级标准要能独立理解。 |
| 8 | [Noul](https://docs.typesafe.ai/primitives/noul) | Noul 是命题为真的概率，不是程度；多标签可拆成多个 Noul。 |
| 9 | [Advanced: structure](https://docs.typesafe.ai/primitives/advanced) | instructions/criteria 可用结构化 JSON；分类子树可作为描述，需控制体积。 |
| 10 | [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer) | 训练和概率校准的概念介绍；没有公开足以还原模型内部实现的细节。 |
| 11 | [Confidence](https://docs.typesafe.ai/confidence) | confidence 描述概率分布形状，不等于单次回答正确的保证。 |
| 12 | [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one) | 先分解判断，把可确定计算交给代码；独立问题同批发送。 |
| 13 | [Example use cases](https://docs.typesafe.ai/concepts/use-case-map) | 行业用例索引，说明组合用途；没有将这些业务模块迁入本项目。 |
| 14 | [Patterns](https://docs.typesafe.ai/patterns) | 四种架构模式入口：fan-out、置信度路由、复合评分、意图路由。 |
| 15 | [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out) | 预问所有已知分支，收到答案后只消费适用分支，可减少往返。 |
| 16 | [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing) | 根据置信度与风险路由；示例阈值不是通用生产策略。 |
| 17 | [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring) | 多个有明确标准的 Score 归一化、加权；策略计算在代码中。 |
| 18 | [Intent routing](https://docs.typesafe.ai/patterns/intent-routing) | Choice 选处理路径，代码派发到确定性处理器、模型或人工。 |
| 19 | [Demos](https://docs.typesafe.ai/demos) | 演示入口；只阅读页面文字，未播放外嵌视频。 |
| 20 | [Smart home assistant demo](https://docs.typesafe.ai/demos/smart-home) | 智能家居同时判断领域、设备、操作；复合指令拆分与自由对话可交 LLM。 |
| 21 | [Client SDKs](https://docs.typesafe.ai/sdk) | 官方 Python 与 JavaScript SDK 入口。 |
| 22 | [TypeSafe Python SDK](https://docs.typesafe.ai/sdk/python) | Python 安装、同步异步客户端、类型化结果和错误处理入口。 |
| 23 | [Usage](https://docs.typesafe.ai/sdk/python/usage) | 重试、日志、原始字典、自定义 Pydantic 响应；debug 正文不脱敏。 |
| 24 | [Changelog](https://docs.typesafe.ai/sdk/python/changelog) | Python 0.7.0 转向 Pydantic 并支持 response_model；旧示例需注意版本。 |
| 25 | [API reference](https://docs.typesafe.ai/sdk/python/api) | Python API 导航，含 clients/types/retries/exceptions/constants。 |
| 26 | [Async client](https://docs.typesafe.ai/sdk/python/api/clients/async) | 异步客户端上下文管理；关闭时也关闭外部传入的 HTTP client。 |
| 27 | [Sync client](https://docs.typesafe.ai/sdk/python/api/clients/sync) | 同步客户端；extra_body 最后浅合并，可覆盖 state/questions/model。 |
| 28 | [Questions](https://docs.typesafe.ai/sdk/python/api/types/questions) | Python 问题模型和 JSON schema；instructions 可空，须与 HTTP 文档区分。 |
| 29 | [Answers and responses](https://docs.typesafe.ai/sdk/python/api/types/responses) | 答案分类访问、模型和用量、原始响应；未知答案类型跳过并警告。 |
| 30 | [Retries](https://docs.typesafe.ai/sdk/python/api/retries) | Python 默认最多重试 2 次；有总重试时间预算及 Retry-After 处理。 |
| 31 | [Common types](https://docs.typesafe.ai/sdk/python/api/types/common) | JSONContent 与递归 JSONValue；顶层 state 类型和嵌套值类型不同。 |
| 32 | [Exceptions](https://docs.typesafe.ai/sdk/python/api/exceptions) | 连接、超时、状态错误和响应验证错误；验证错误含字段路径。 |
| 33 | [Constants](https://docs.typesafe.ai/sdk/python/api/constants) | Python 环境变量名、默认地址、默认模型及超时常量。 |
| 34 | [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) | JavaScript SDK 支持 Node 20+，ESM/CJS，问题到结果的类型推导。 |
| 35 | [Changelog](https://docs.typesafe.ai/sdk/javascript/changelog) | JavaScript 0.6.0 的 Score criteria 数组变更。 |
| 36 | [API reference](https://docs.typesafe.ai/sdk/javascript/api) | JavaScript 类、接口、类型别名、常量与构造函数总入口。 |
| 37 | [Class: APIConnectionError](https://docs.typesafe.ai/sdk/javascript/api/classes/APIConnectionError) | 连接类错误，区别于 HTTP 状态错误。 |
| 38 | [Class: APIError](https://docs.typesafe.ai/sdk/javascript/api/classes/APIError) | APIError 携带状态、响应体、headers 和 requestID。 |
| 39 | [Class: APIPromise<T>](https://docs.typesafe.ai/sdk/javascript/api/classes/APIPromise) | APIPromise 支持 withResponse/asResponse；原始响应读取有消费与超时边界。 |
| 40 | [Class: APITimeoutError](https://docs.typesafe.ai/sdk/javascript/api/classes/APITimeoutError) | 请求超时错误类型。 |
| 41 | [Class: APIUserAbortError](https://docs.typesafe.ai/sdk/javascript/api/classes/APIUserAbortError) | 调用者通过 AbortSignal 主动取消的错误类型。 |
| 42 | [Class: AuthenticationError](https://docs.typesafe.ai/sdk/javascript/api/classes/AuthenticationError) | 401 身份验证错误。 |
| 43 | [Class: BadRequestError](https://docs.typesafe.ai/sdk/javascript/api/classes/BadRequestError) | 400 请求错误。 |
| 44 | [Class: InternalServerError](https://docs.typesafe.ai/sdk/javascript/api/classes/InternalServerError) | 服务端 5xx 错误类型。 |
| 45 | [Class: NotFoundError](https://docs.typesafe.ai/sdk/javascript/api/classes/NotFoundError) | 404 未找到错误。 |
| 46 | [Class: PermissionDeniedError](https://docs.typesafe.ai/sdk/javascript/api/classes/PermissionDeniedError) | 403 权限错误。 |
| 47 | [Class: RateLimitError](https://docs.typesafe.ai/sdk/javascript/api/classes/RateLimitError) | 429 限流错误，包含 retryAfterMs。 |
| 48 | [Class: TypeSafeClient](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient) | TypeSafeClient 的构造配置、systemOne 与 models 资源。 |
| 49 | [Class: TypeSafeError](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeError) | SDK 错误基类。 |
| 50 | [Class: UnprocessableEntityError](https://docs.typesafe.ai/sdk/javascript/api/classes/UnprocessableEntityError) | 422 输入验证错误。 |
| 51 | [Interface: ChoiceQuestion<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceQuestion) | ChoiceQuestion 泛型约束候选及返回键；instructions 可选可空。 |
| 52 | [Interface: ChoiceResponse<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceResponse) | ChoiceResponse 含 choice、probabilities、confidence。 |
| 53 | [Interface: Logger](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Logger) | 可注入 Logger，提供不同级别的日志方法。 |
| 54 | [Interface: ModelCard](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ModelCard) | ModelCard 包含名称、描述和发布日期。 |
| 55 | [Interface: Models](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Models) | models.list 返回模型卡列表的 APIPromise。 |
| 56 | [Interface: NoulQuestion](https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulQuestion) | NoulQuestion 的 instructions 与可选真假 criteria。 |
| 57 | [Interface: NoulResponse](https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulResponse) | NoulResponse 返回 noul 概率，没有独立 confidence 字段。 |
| 58 | [Interface: Questions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Questions) | Questions 是名称到问题的映射。 |
| 59 | [Interface: RequestOptions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions) | 单次请求可覆盖 headers/retry/timeout 并传入取消 signal。 |
| 60 | [Interface: RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy) | JS 重试退避和 Retry-After 上限；每次尝试超时，没有 Python 式总预算。 |
| 61 | [Interface: ScoreQuestion<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreQuestion) | ScoreQuestion 接受按等级排列的 criteria。 |
| 62 | [Interface: ScoreResponse<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreResponse) | ScoreResponse 返回 score、等级概率、legend、confidence。 |
| 63 | [Interface: SystemOneRequest<Q>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequest) | SystemOneRequest 含 state/questions 和可选 model；EntryType 包含 null。 |
| 64 | [Interface: SystemOneRequestPayload](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequestPayload) | 实际传输 payload 的 model 为必填字段。 |
| 65 | [Interface: SystemOneResult<Q>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult) | SystemOneResult 按问题类型推导 answers，并含 model/usage。 |
| 66 | [Interface: TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig) | 客户端配置含 fetch、logger、重试；默认禁止浏览器环境以免暴露 key。 |
| 67 | [Interface: Usage](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Usage) | Usage 的输入、输出、总 token 数。 |
| 68 | [Interface: WithResponse<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/WithResponse) | WithResponse 将解析数据与 HTTP Response 元数据组合。 |
| 69 | [Type Alias: ChoiceCriteria](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ChoiceCriteria) | ChoiceCriteria 为候选名到 Description 的映射。 |
| 70 | [Type Alias: Description](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Description) | Description 支持结构化描述，不限于纯字符串。 |
| 71 | [Type Alias: EntryType](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/EntryType) | EntryType 为字符串、对象、数组或 null；与 Python 顶层 state 文档存在差别。 |
| 72 | [Type Alias: EnvVar](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/EnvVar) | EnvVar 环境变量值类型。 |
| 73 | [Type Alias: Fetch](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Fetch) | Fetch 可注入请求实现的类型。 |
| 74 | [Type Alias: JsonValue](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/JsonValue) | JsonValue 递归覆盖 JSON 标量、数组和对象。 |
| 75 | [Type Alias: LogLevel](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/LogLevel) | LogLevel 为受支持的日志级别联合类型。 |
| 76 | [Type Alias: Question](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Question) | Question 为 Choice/Noul/Score 的联合类型。 |
| 77 | [Type Alias: ResultFor<T>](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ResultFor) | ResultFor 根据题型推导响应类型。 |
| 78 | [Type Alias: ScoreCriteria](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ScoreCriteria) | ScoreCriteria 的元组类型要求至少两项；仍须遵守服务端上限。 |
| 79 | [Type Alias: ScoreLegend<T>](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ScoreLegend) | ScoreLegend 将等级映射回描述。 |
| 80 | [Type Alias: ScoreOf<T>](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ScoreOf) | ScoreOf 从 criteria 的元组索引推导等级类型。 |
| 81 | [Variable: ENV](https://docs.typesafe.ai/sdk/javascript/api/variables/ENV) | ENV 声明 API key、base URL、默认模型、日志级别环境变量名。 |
| 82 | [Variable: LOG_LEVELS](https://docs.typesafe.ai/sdk/javascript/api/variables/LOG_LEVELS) | LOG_LEVELS 导出的级别顺序常量。 |
| 83 | [Variable: VERSION](https://docs.typesafe.ai/sdk/javascript/api/variables/VERSION) | VERSION 文档标注 JavaScript SDK 0.6.0。 |
| 84 | [Function: choice()](https://docs.typesafe.ai/sdk/javascript/api/functions/choice) | choice() 构造保留候选泛型的 ChoiceQuestion。 |
| 85 | [Function: noul()](https://docs.typesafe.ai/sdk/javascript/api/functions/noul) | noul() 构造 NoulQuestion，提供多种参数形式。 |
| 86 | [Function: score()](https://docs.typesafe.ai/sdk/javascript/api/functions/score) | score() 构造保留等级类型的 ScoreQuestion。 |
| 87 | [Models](https://docs.typesafe.ai/models) | 当前 Jev 1.13.0、文本限制、上下文和价格；别名可能变化。 |
| 88 | [API reference](https://docs.typesafe.ai/api) | HTTP 请求响应、认证、限制与错误码；没有 messages/system/tools 字段。 |
| 89 | [Agent skill](https://docs.typesafe.ai/agent-skill) | 官方 Agent skill 的安装与更新说明；本次只阅读，没有安装或执行它。 |
| 90 | [Legal](https://docs.typesafe.ai/legal) | 法律文档链接页及企业 ZDR 信息；外链合同全文不计入本站 109 页。 |
| 91 | [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) | 1.13 弱点：字面理解、算术、多跳、长上下文干扰、注入与逻辑不一致。 |
| 92 | [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook) | 重复 Noul 实验；新增随机 uid 混入输入敏感性，稳定不代表准确。 |
| 93 | [Self-consistency: choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook) | Choice 实验展示弃权提高决策一致性，同时降低自动处理覆盖率。 |
| 94 | [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) | 13 题合批节省重复 state；10 倍速度对比的基线是串行调用。 |
| 95 | [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe) | BM25 粗筛后每个候选独立 Noul 重排；不能找回未进入 shortlist 的结果。 |
| 96 | [Line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find) | 218 行 ID Choice 加 exists Noul；最高相对概率不代表答案确实存在。 |
| 97 | [Structure recovery](https://docs.typesafe.ai/cookbooks/autoformat) | 先拼接断行，再分类生成的块；同批预问附属属性，代码负责渲染。 |
| 98 | [Function calling](https://docs.typesafe.ai/cookbooks/function_calling) | 函数及封闭参数拆成 Choice/Noul，一次请求 54 题；代码执行选中的函数。 |
| 99 | [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) | 182 skills 粗排取三再细读；有误荐和 Choice/Noul 分歧，非可靠性保证。 |
| 100 | [Knowledge graph entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment) | 三级 Score 映射不合并/复核/合并；字段 Noul 补充证据，舍入隐含切点。 |
| 101 | [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages) | RAG 逐段判断相关、证据、矛盾和注入；路由顺序重要，过滤不是安全边界。 |
| 102 | [Double-checking citations](https://docs.typesafe.ai/cookbooks/citation_check) | 代码匹配原文，再用 Choice 判断是否支持论点；精确匹配有误拒局限。 |
| 103 | [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails) | 输入输出分别筛查，概率与政策分离；不能据示例宣称免疫提示注入。 |
| 104 | [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade) | 小模型提取、Jev 逐字段验证、强模型回退；示例含硬编码结果与内部基准。 |
| 105 | [Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook) | 7 个并行 Choice 提取日期部件，代码做日历计算、缺失和非法组合检查。 |
| 106 | [Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook) | 正则过度召回候选，Choice 选原文值，代码规范化；候选发现仍是工程工作。 |
| 107 | [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification) | 层级 Choice 与宽度 3 beam search；几何均值是路径排名规则，不是正确率。 |
| 108 | [Autoresearch feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery) | LLM 提议问题、Jev 产出特征、CatBoost 拟合、开发集反馈；不是微调 Jev。 |
| 109 | [Classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence) | 低 confidence 时返回更粗分类；60 篇样本的精度与粒度交换需区分。 |
