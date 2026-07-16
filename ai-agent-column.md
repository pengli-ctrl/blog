---
title: AI Agent 架构实战专栏
description: 从单Agent到事件驱动多Agent编排平台的完整架构演进
---

# 🤖 AI Agent 架构实战专栏

> 本专栏记录了一个 AI Agent 编排平台从 0 到 1 的完整架构演进过程，
> 以及支撑它的传统分布式架构底座和 RAG 工程化实战经验。

## 📖 专栏目录

### AI Agent 系列

| # | 标题 | 核心内容 | 状态 |
|---|------|---------|------|
| 01 | [RAG工程化实战：代码审查场景幻觉率从46%降到16.2%的五层防护体系](/posts/01-rag-engineering-hallucination-prevention) | AST感知分块、混合检索+RRF、LLM Rerank、生成约束、RAGAS评估 | ✅ 已发布 |
| 04 | [AI Agent 多智能体编排架构实战：从单Agent到事件驱动的架构演进与踩坑全记录](/posts/04-agentforge-architecture-evolution) | 三版架构设计对比、事件总线、状态隔离、工具沙箱 | ✅ 已发布 |
| 05 | [从规则引擎到LLM动态编排——多Agent编排引擎的演进路线与渐进式升级策略](/posts/05-orchestration-engine-evolution) | Plan-and-Execute、CORAL、AFlow 三大方向，混合编排共识，渐进式升级策略 | ✅ 已发布 |
| 06 | [事件驱动多Agent编排的故障模式推演——四类典型风险的根因分析与容错设计](/posts/06-production-failure-patterns) | 并发同步脉冲、目标冲突活跃锁、语义自洽陷阱、拥塞崩溃，四层容错防线 | ✅ 已发布 |

### 分布式架构底座

| # | 标题 | 核心内容 | 状态 |
|---|------|---------|------|
| 02 | [一个15微服务OpenAPI平台的架构实战：分库分表、分布式事务与300+接口灰度迁移](/posts/02-openapi-platform-architecture) | DDD领域建模、ShardingSphere分库分表、Saga分布式事务、双级缓存 | ✅ 已发布 |
| 03 | [300+接口零事故灰度迁移：技术方案只占40%，剩下60%是项目管理](/posts/03-grayscale-migration-project-management) | 利益相关方管理、双写双读+流量灰度、计费Bug实录、五步法沉淀 | ✅ 已发布 |

## 🎯 这个专栏适合谁看

- 正在做 AI Agent / LLM 应用开发的后端工程师
- 需要设计多 Agent 协作系统的架构师
- 对 AI 工程化落地感兴趣的技术负责人
- 想了解 Agent 编排平台内部实现原理的开发者
- 想看到 AI + 传统分布式架构交叉视角的技术人

## 💡 专栏特色

- **每篇都有架构图**，不空谈概念
- **所有代码片段可直接运行**，AI 部分基于 Python + vLLM，分布式部分基于 Java + Spring
- **量化数据**：延迟、吞吐量、幻觉率、RAGAS评分都有实测数字
- **踩坑复盘**：不只写"做对了什么"，更写"做错了什么以及为什么改"
- **交叉验证**：Agent 架构中的灰度策略（04）和分布式平台的灰度迁移（03）互相印证

---

> 💬 如果你也在做 Agent 相关架构设计，欢迎通过 [GitHub](https://github.com/pengli-ctrl) 或评论区交流。
