---
title: "RAG工程化实战：代码审查场景幻觉率从46%降到16.2%的五层防护体系"
description: "在深信服AI Code Copilot项目中，我们用五层防护体系将代码审查幻觉率从46%降到16.2%。本文完整拆解分块、检索、排序、生成约束、评估每一层的工程细节和踩坑经验。"
date: 2024-01-20
tags:
  - RAG
  - AI工程化
  - 代码审查
  - 幻觉防护
  - LLM评估
---

# RAG工程化实战：代码审查场景幻觉率从46%降到16.2%的五层防护体系

## 一、RAG不难，工程化RAG才难

2023年，我在深信服做AI Code Copilot。核心功能说起来不复杂：用RAG检索内部代码库和编码规范文档，帮LLM做代码审查——开发提交一段代码，系统自动检查逻辑漏洞、风格问题、安全隐患，给出审查意见。

这个需求听起来太经典了，经典到一周就能搭出demo。LangChain + FAISS + 一个prompt模板，跑起来轻轻松松。我当时也是这么想的。

然后第一版上线内部灰度，真实数据一跑，我傻眼了。

**幻觉率46%。**

将近一半的审查建议是瞎编的。系统会信誓旦旦地告诉开发者"这个函数没有做参数校验，建议加上"，但实际上参数校验明明在另一个文件里实现了；会指出"这个加密算法不符合公司规范"，但它引用的"规范"根本不存在；甚至会编造一个从未见过的内部API名称，让开发者一脸懵地去全局搜索。

这不是prompt写得不够好能解释的。这是整条RAG链路的系统性问题——分块把代码结构切碎了，检索把不相关的内容捞上来了，排序把最该引用的chunk排下去了，生成时LLM又在自由发挥。每一层都在引入噪声，五层噪声叠加，结果就是46%的幻觉。

我没有选择去调prompt，而是花了三个月，从零重构了整条RAG链路。最终设计了一套五层防护体系，从分块、检索、排序、生成约束到评估，逐层控制幻觉。

最终效果：

| 指标 | v1 (demo) | v20 (最终) | 变化 |
|------|-----------|------------|------|
| 幻觉率 | 46% | 16.2% | **-64.7%** |
| 忠实度 (Faithfulness) | 0.53 | 0.83 | **+55.4%** |
| 审查准确率 | 60% | 85% | **+41.7%** |
| RAGAS综合分 | 0.4172 | 0.5829 | **+39.8%** |

这中间经历了v15到v20共6个大版本的迭代，每个版本都有量化对比，每个优化点都对应具体的数据变化。

下面逐层拆解。

> **背景说明**：深信服是安全公司，合规要求所有模型必须私有化部署。我们的模型全部通过vLLM部署Qwen2.5-Coder系列，不调用任何外部API。这一点反而倒逼我们在工程层面做了更多优化——没有GPT-4兜底，每一步都必须做对。

---

## 二、第一层：分块策略——AST感知 vs 暴力切割

### 问题：代码不是自然语言

LangChain默认的`RecursiveCharacterTextSplitter`是为人设计的。它的逻辑是按字符数递归切分，先按`\n\n`切，不够再按`\n`切，再不够按空格切。对文档来说这没问题，但对代码来说，这是在犯罪。

看一个例子：

```python
class SecurityValidator:
    def validate_input(self, data: dict) -> bool:
        """验证输入数据的安全性"""
        if not isinstance(data, dict):
            raise TypeError("Input must be a dict")
        return self._check_encoding(data) and self._check_length(data)

    def _check_encoding(self, data: dict) -> bool:
        """检查数据编码是否安全"""
        for key, value in data.items():
            if isinstance(value, str):
                try:
                    value.encode('utf-8')
                except UnicodeEncodeError:
                    return False
        return True

    def _check_length(self, data: dict) -> bool:
        """检查数据长度是否在限制范围内"""
        for key, value in data.items():
            if len(str(value)) > self.max_length:
                logger.warning(f"Field {key} exceeds max length")
                return False
        return True
```

如果用`RecursiveCharacterTextSplitter`按500字符切，`validate_input`方法和`_check_encoding`方法可能被切到同一个chunk，但`_check_length`可能被切到下一个chunk。更糟的是，如果chunk边界恰好在函数中间，你会得到半个函数——LLM看到一个没有`return`的不完整函数，它能不编吗？

### 方案：AST感知分块

我们用`tree-sitter`来解析代码的抽象语法树（AST），按**函数/类/方法**的级别切分，保证每个chunk都是一个完整的语法单元。

核心思路：

1. 用tree-sitter解析源文件，得到AST
2. 遍历AST，找到所有函数定义（`function_definition`）和类定义（`class_definition`）节点
3. 每个节点作为一个chunk，提取其源代码文本
4. 对于类，其内部的每个方法也单独作为chunk
5. 每个chunk附带结构化元数据

```python
import tree_sitter_python as tspython
from tree_sitter import Language, Parser

PYTHON_LANGUAGE = Language(tspython.language())
parser = Parser(PYTHON_LANGUAGE)

def ast_aware_chunk(file_path: str, source_code: bytes):
    """AST感知的代码分块"""
    tree = parser.parse(source_code)
    root_node = tree.root_node
    chunks = []

    for child in root_node.children:
        if child.type == 'class_definition':
            # 类整体作为一个chunk
            class_text = source_code[child.start_byte:child.end_byte].decode()
            class_name = _extract_class_name(child)
            chunks.append({
                'content': class_text,
                'metadata': {
                    'file_path': file_path,
                    'type': 'class',
                    'name': class_name,
                    'methods': _extract_method_names(child),
                    'imports': _extract_imports(root_node, source_code),
                }
            })
            # 类的每个方法也单独作为一个chunk
            for method in _find_child_nodes(child, 'function_definition'):
                method_text = source_code[method.start_byte:method.end_byte].decode()
                chunks.append({
                    'content': method_text,
                    'metadata': {
                        'file_path': file_path,
                        'type': 'method',
                        'class': class_name,
                        'name': _extract_function_name(method),
                        'signature': _extract_signature(method, source_code),
                        'imports': _extract_imports(root_node, source_code),
                    }
                })

        elif child.type == 'function_definition':
            # 顶层函数作为一个chunk
            func_text = source_code[child.start_byte:child.end_byte].decode()
            chunks.append({
                'content': func_text,
                'metadata': {
                    'file_path': file_path,
                    'type': 'function',
                    'name': _extract_function_name(child),
                    'signature': _extract_signature(child, source_code),
                    'imports': _extract_imports(root_node, source_code),
                }
            })

    return chunks
```

### 元数据的作用

元数据不是装饰品，它直接服务于后续的检索和生成。

举个具体例子：当开发者问"SecurityValidator的validate_input方法有没有做长度校验"时，检索系统不仅需要找到`validate_input`的代码，还需要找到`_check_length`的代码。如果我们知道这两个方法属于同一个类（通过元数据中的`class`字段），就可以在检索时做关联扩展——找到`validate_input`后，自动把同类的`_check_length`也拉进来。

### 效果对比

我们在50条Golden Dataset上做了AB对比：

| 分块策略 | 检索Recall@10 | 幻觉率 |
|----------|--------------|--------|
| 固定500字符切分 | 0.58 | 43% |
| RecursiveCharacterTextSplitter | 0.62 | 38% |
| **AST感知分块** | **0.79** | **28%** |

AST感知分块把检索Recall@10从0.62拉到了0.79，幻觉率从38%直接降到28%。这是第一个显著的收益——**你给LLM的上下文质量提升了，它就没那么大动力去编了**。

但28%还是太高，远远不够。继续往下看。

---

## 三、第二层：检索——混合检索+RRF融合

### 问题：单路检索的盲区

有了AST分块，下一步是检索。最初我们只用了FAISS做向量检索——把query和chunk都编码成向量，算余弦相似度，取Top-K。

向量检索对语义相似的场景效果很好。比如query是"如何处理用户输入的非法字符"，它能找到`sanitize_input`函数，即使函数名和query没有字面重叠。

但代码审查场景有一个特点：**大量query包含精确的函数名、类名、变量名**。比如"SecurityValidator的validate_input是否存在空指针风险"，这里`SecurityValidator`和`validate_input`是精确关键词，向量检索反而不擅长处理这种精确匹配。

我观察到：在向量检索的Top-10结果中，有时候`SecurityValidator`类的代码被排在第6、7位，反而是一些语义相近但毫不相关的"验证类"代码排在了前面。向量空间里，"安全验证"和"输入验证"和"数据校验"的向量可能非常接近，但在业务逻辑上它们是完全不同的东西。

反过来，BM25对关键词精确匹配很强，但对语义相似无能为力。query说"如何处理非法字符"，BM25很难找到名叫`sanitize_input`的函数，因为字面上完全不重叠。

### 方案：双路检索 + RRF融合

解决方案很直接：两条路都跑，然后融合。

```python
from rank_bm25 import BM25Okapi
import faiss
import numpy as np

def hybrid_search(query: str, top_k: int = 20):
    """BM25 + FAISS 混合检索，RRF融合"""

    # 路1: BM25 关键词检索
    bm25_scores = bm25_index.get_scores(query)
    bm25_top_indices = np.argsort(bm25_scores)[::-1][:top_k * 2]
    bm25_rank = {int(idx): rank for rank, idx in enumerate(bm25_top_indices)}

    # 路2: FAISS 向量检索
    query_embedding = embed_model.encode([query])
    _, faiss_top_indices = faiss_index.search(query_embedding, top_k * 2)
    faiss_rank = {int(idx): rank for rank, idx in enumerate(faiss_top_indices[0])}

    # RRF 融合
    k = 60  # RRF 常数
    fused_scores = {}
    all_indices = set(bm25_rank.keys()) | set(faiss_rank.keys())

    for idx in all_indices:
        score = 0.0
        if idx in bm25_rank:
            score += 1.0 / (k + bm25_rank[idx])
        if idx in faiss_rank:
            score += 1.0 / (k + faiss_rank[idx])
        fused_scores[idx] = score

    # 按融合分数排序
    sorted_indices = sorted(fused_scores.keys(), key=lambda x: fused_scores[x], reverse=True)
    return sorted_indices[:top_k]
```

### 为什么用RRF而不是学习排序（LTR）

RRF（Reciprocal Rank Fusion）的公式非常简单：

$$RRF\_score(d) = \sum_{r \in R} \frac{1}{k + rank_r(d)}$$

其中$k=60$是常数，$rank_r(d)$是文档$d$在第$r$路检索中的排名。

选择RRF而不是LTR（Learning to Rank），原因很务实：

1. **训练数据不够**。LTR需要标注好的(query, document, relevance)三元组来训练排序模型，我们只有50条Golden Dataset，不够训练一个靠谱的排序模型。
2. **RRF是无需训练的**。它不需要任何参数学习，纯粹基于排名融合，在数据量有限的场景下反而是最优选择。
3. **工程简单**。RRF的实现就上面那十几行代码，维护成本极低。
4. **效果够用**。在我们的评测中，RRF融合相比单路检索，Recall@10提升了12个百分点。

### 效果

| 检索方案 | Recall@10 | Recall@20 | 幻觉率 |
|----------|-----------|-----------|--------|
| 纯FAISS向量检索 | 0.65 | 0.72 | 26% |
| 纯BM25检索 | 0.57 | 0.64 | 31% |
| **BM25 + FAISS + RRF** | **0.79** | **0.86** | **21%** |

混合检索把幻觉率从26%压到了21%。进展明显，但还是不够。继续。

---

## 四、第三层：Rerank——LLM二次排序

### 问题：检索Top-20里混着垃圾

混合检索+RRF融合后，Top-20的chunk整体质量已经不错了。但"整体不错"和"最相关的5个"之间还有差距。Top-20里可能还有3-5个看起来相关但实际不靠谱的chunk——比如同名但不同模块的函数、已经废弃的旧版本实现、测试用例里的mock方法。

如果直接把这20个chunk全部喂给LLM做生成，那些不相关的chunk就是潜在的幻觉来源。LLM的注意力机制会被无关内容干扰，尤其是当chunk数量多的时候。

### 方案：用LLM做Rerank

业界常用的Rerank方案有两种：Cross-Encoder模型（如`bge-reranker`）和LLM Rerank。

我们选了LLM Rerank，原因还是合规：安全公司不能随便往服务器上装外部模型。`bge-reranker`虽然效果好，但它是一个独立模型，需要额外的推理资源和部署审批。而我们已经有vLLM部署的Qwen2.5-Coder，直接用它做Rerank，不需要额外部署任何东西。

Prompt设计：

```python
RERANK_PROMPT = """你是一个代码审查助手。请根据以下代码审查问题，对每个代码片段的相关性进行评分。

## 审查问题
{query}

## 代码片段列表
{chunks_text}

## 评分要求
请对每个代码片段给出0-10的相关性评分，评分标准：
- 9-10分：直接包含回答问题所需的核心代码
- 7-8分：包含相关代码，但不完整或需要配合其他片段
- 4-6分：间接相关，可能在同一模块或涉及相同的接口
- 1-3分：仅有少量关键词重叠，实际不相关
- 0分：完全不相关

## 输出格式
请按JSON格式输出：
{{"scores": [{{"chunk_id": "chunk_0", "score": 8}}, ...]}}
"""
```

流程是：

1. 混合检索取Top-20个chunk
2. 把这20个chunk + query拼成上面的prompt，发给Qwen2.5-Coder
3. 拿到每个chunk的相关性评分
4. 按评分排序，取Top-5进入生成阶段

### 延迟与收益的Trade-off

LLM Rerank不是免费的。每次Rerank需要一次LLM推理调用，在我们的A100上大约增加800ms延迟。

但收益是显著的。Rerank后进入生成阶段的5个chunk，质量比直接从Top-20中取Top-5高出很多。我统计过，Rerank前Top-20中"真正相关"的chunk平均有8.3个（人工标注标准），但它们分散在Top-20各处；Rerank后Top-5中"真正相关"的chunk平均有4.2个——**精度从41.5%（8.3/20）提升到了84%（4.2/5）**。

| 阶段 | 幻觉率 |
|------|--------|
| AST分块后 | 28% |
| + 混合检索+RRF | 21% |
| **+ LLM Rerank** | **18.5%** |

---

## 五、第四层：生成约束——让LLM"不敢"编

经过前三层，进入生成阶段的上下文质量已经相当高了。但LLM天生就有"脑补"的倾向——即使你给了它完美的上下文，它也有可能超出上下文范围自由发挥。

这是第四层要解决的问题：**通过prompt约束和后处理验证，把LLM的自由发挥空间压到最小**。

### Prompt约束

核心思路是三条硬规则：

1. **信息来源约束**：明确告诉LLM只能基于提供的代码片段回答
2. **引用格式约束**：每句话必须标注来源，便于事后验证
3. **输出格式约束**：结构化JSON输出，减少自由发挥空间

```python
GENERATION_PROMPT = """你是一个专业的代码审查助手。请严格基于以下代码片段进行审查。

## 待审查代码
{target_code}

## 检索到的相关代码片段
{context_chunks}

## 审查要求
1. **仅基于以上代码片段进行审查**，不要使用你的训练知识补充
2. 如果代码片段中的信息不足以判断某个问题，请明确标注"信息不足，无法判断"
3. 每个审查意见必须引用具体的代码片段来源
4. 不要编造代码片段中不存在的函数名、类名、变量名或API

## 输出格式（严格JSON）
{{
  "review_items": [
    {{
      "severity": "error|warning|info",
      "category": "security|logic|style|performance",
      "description": "问题描述",
      "evidence": "从代码片段中引用的具体代码行",
      "source_chunks": ["chunk_3", "chunk_7"],
      "suggestion": "修改建议"
    }}
  ],
  "confidence": 0.0-1.0,
  "info_sufficient": true|false
}}
"""
```

### 后处理验证

Prompt约束是"软限制"，LLM不一定每次都遵守。所以我们加了一层后处理验证——**用代码检查LLM的输出是否真的遵守了约束**。

核心逻辑：

```python
import re
import json

def verify_generation(llm_output: str, context_chunks: dict) -> dict:
    """验证LLM输出中的引用是否真实存在"""
    try:
        result = json.loads(llm_output)
    except json.JSONDecodeError:
        return {"valid": False, "reason": "JSON解析失败"}

    hallucination_flags = []

    for item in result.get("review_items", []):
        # 检查1: 引用的chunk_id是否真实存在于上下文中
        for chunk_id in item.get("source_chunks", []):
            if chunk_id not in context_chunks:
                hallucination_flags.append({
                    "type": "fake_reference",
                    "detail": f"引用了不存在的chunk: {chunk_id}",
                    "item": item["description"]
                })

        # 检查2: evidence中的代码是否真的出现在引用的chunk中
        evidence = item.get("evidence", "")
        referenced_content = " ".join([
            context_chunks.get(cid, "")
            for cid in item.get("source_chunks", [])
        ])
        if evidence and evidence not in referenced_content:
            # 允许一定程度的缩略，但至少要有50%的关键词匹配
            evidence_keywords = set(re.findall(r'\w+', evidence))
            context_keywords = set(re.findall(r'\w+', referenced_content))
            overlap = len(evidence_keywords & context_keywords) / max(len(evidence_keywords), 1)
            if overlap < 0.5:
                hallucination_flags.append({
                    "type": "fabricated_evidence",
                    "detail": "引用的代码证据在上下文中不存在",
                    "item": item["description"]
                })

        # 检查3: 是否提到了上下文中不存在的函数名/类名
        mentioned_names = set(re.findall(
            r'(?:def|class)\s+(\w+)', item.get("description", "")
        ))
        context_names = set(re.findall(r'\w+', referenced_content))
        phantom_names = mentioned_names - context_names
        if phantom_names:
            hallucination_flags.append({
                "type": "phantom_reference",
                "detail": f"提到了上下文中不存在的名称: {phantom_names}",
                "item": item["description"]
            })

    return {
        "valid": len(hallucination_flags) == 0,
        "hallucination_count": len(hallucination_flags),
        "flags": hallucination_flags,
        "cleaned_result": _remove_flagged_items(result, hallucination_flags)
    }
```

这层验证的本质是：**不信任LLM的输出，用代码逻辑做硬校验**。引用了不存在的chunk？标为幻觉。引用的代码片段在上下文中找不到？标为幻觉。编造了上下文中不存在的函数名？标为幻觉。

被标记的审查意见不会直接丢弃，而是标记为"疑似幻觉"，在前端展示时降低优先级或加灰色标注。

### 效果

| 阶段 | 幻觉率 |
|------|--------|
| Rerank后 | 18.5% |
| **+ 生成约束+后处理验证** | **16.8%** |

这一层单独看只降了不到2个百分点，但它的作用不仅仅是降低幻觉率——**它把幻觉"显性化"了**。以前46%的幻觉率时，LLM编了什么你完全看不出来；现在即使有16.8%的幻觉，后处理验证也能标记出大部分，用户至少知道哪些结论可能不靠谱。

---

## 六、第五层：评估——RAGAS + Golden Dataset

前面四层是"防"，这一层是"测"。没有评估体系，前面所有的优化都是盲人摸象——你不知道改了一版之后效果是变好了还是变差了。

### RAGAS四维评估框架

我们采用RAGAS（Retrieval Augmented Generation Assessment）作为评估框架。RAGAS提供四个维度的指标，每个维度衡量RAG系统不同环节的质量：

**1. Faithfulness（忠实度）**

衡量生成的回答是否忠于检索到的上下文。如果LLM说了上下文里没有的信息，Faithfulness就会低。这是最直接的幻觉指标。

**2. Answer Relevancy（回答相关性）**

衡量生成的回答是否切题。如果LLM答非所问，或者回答了一堆但没解决实际问题，这个分数就会低。

**3. Context Precision（上下文精确度）**

衡量检索到的chunk中，有多少是真正对回答问题有用的。精确度低意味着检索系统捞了一堆噪声进来。

**4. Context Recall（上下文召回率）**

衡量回答问题所需的信息是否都被检索到了。召回率低意味着关键信息被漏掉了。

```python
from ragas import evaluate
from ragas.metrics import (
    faithfulness,
    answer_relevancy,
    context_precision,
    context_recall,
)
from datasets import Dataset

def evaluate_rag_pipeline(golden_dataset: list, rag_pipeline):
    """评估RAG管线"""
    questions = []
    answers = []
    contexts = []
    ground_truths = []

    for item in golden_dataset:
        # 用RAG管线生成回答
        result = rag_pipeline.query(item["question"])

        questions.append(item["question"])
        answers.append(result["answer"])
        contexts.append(result["retrieved_chunks"])  # 检索到的chunk列表
        ground_truths.append(item["ground_truth"])

    # 构造评估数据集
    eval_dataset = Dataset.from_dict({
        "question": questions,
        "answer": answers,
        "contexts": contexts,
        "ground_truth": ground_truths,
    })

    # 执行评估
    scores = evaluate(
        eval_dataset,
        metrics=[faithfulness, answer_relevancy, context_precision, context_recall]
    )
    return scores
```

### Golden Dataset构建

评估的基础是50条Golden Dataset。每条数据包含三个部分：

- **query**：一条真实的代码审查问题
- **ground_truth_context**：回答这个问题需要的代码片段（人工标注）
- **ground_truth_answer**：标准审查意见（人工标注）

覆盖的场景包括：

| 场景类型 | 数量 | 示例 |
|----------|------|------|
| 跨文件逻辑检查 | 12 | "这个函数调用的加密方法实现是否正确？" |
| 编码规范合规 | 10 | "这段代码是否符合公司安全编码规范？" |
| API使用正确性 | 8 | "这个内部SDK的调用参数是否正确？" |
| 安全漏洞检测 | 10 | "这段SQL拼接是否存在注入风险？" |
| 性能问题检查 | 5 | "这个循环中是否存在不必要的数据库查询？" |
| 边界条件检查 | 5 | "这个函数是否正确处理了空输入？" |

50条不算多，但每一条都是真实场景中遇到的、有明确对错标准的case。构建这50条数据花了两个高级工程师大约一周的时间，但这一周的投入让整个项目的迭代效率提升了数倍。

### LLM-as-Judge

RAGAS的评估本身依赖LLM来打分——它用一个LLM实例来判断另一个LLM实例的输出质量。这就是所谓的LLM-as-Judge。

我最初对此有疑虑：用LLM评LLM，靠谱吗？

做了验证实验：请两位高级工程师对50条数据做独立人工评分（1-5分制），同时用LLM-as-Judge打分，然后算两者的一致性。

结果：

| 维度 | LLM-vs-人工一致率 | Pearson相关系数 |
|------|-------------------|-----------------|
| Faithfulness | 88% | 0.91 |
| Answer Relevancy | 85% | 0.87 |
| Context Precision | 83% | 0.84 |
| Context Recall | 82% | 0.82 |

一致率都在82%以上，Pearson相关系数都超过0.8。作为一个自动评估方案，这个精度完全可以接受。关键是它**快且免费**——50条数据的人工评分需要一周，而LLM-as-Judge跑一遍只需要15分钟。

### 迭代过程中的量化追踪

有了评估体系，每一次优化都能看到精确的数据变化。下面是v15到v20的迭代记录：

| 版本 | Faithfulness | Answer Relevancy | Context Precision | Context Recall | 综合分 | 主要改动 |
|------|-------------|------------------|-------------------|----------------|--------|----------|
| v15 | 0.61 | 0.38 | 0.42 | 0.26 | 0.4172 | 基线版本 |
| v16 | 0.65 | 0.41 | 0.48 | 0.31 | 0.4625 | AST分块优化 |
| v17 | 0.71 | 0.45 | 0.53 | 0.35 | 0.5100 | 引入BM25混合检索 |
| v18 | 0.76 | 0.49 | 0.58 | 0.39 | 0.5550 | LLM Rerank |
| v19 | 0.80 | 0.51 | 0.61 | 0.42 | 0.5850 | 生成约束+后处理验证 |
| v20 | 0.83 | 0.54 | 0.63 | 0.44 | 0.5829 | Prompt精调+元数据扩展 |

可以看到，每一层优化都对应特定维度的提升：

- AST分块主要提升了**Context Precision**——分块质量高了，检索到的chunk更精准
- 混合检索主要提升了**Context Recall**——双路检索覆盖了更多相关信息
- LLM Rerank主要提升了**Context Precision**——二次排序把噪声chunk排除了
- 生成约束主要提升了**Faithfulness**——LLM更忠实于上下文了

v20的综合分比v19略有下降（0.5829 vs 0.5850），是因为v20的改动（扩展元数据、精调prompt）在Faithfulness上提升了，但Context Recall略有下降。这说明优化不是单调递增的，需要精细平衡。

---

## 七、整体效果与Trade-off

### 效果汇总

经过五层防护体系的逐层优化，最终效果：

| 指标 | v1 (demo) | v20 (最终) | 变化 |
|------|-----------|------------|------|
| 幻觉率 | 46% | 16.2% | **-64.7%** |
| Faithfulness | 0.53 | 0.83 | **+55.4%** |
| 审查准确率 | 60% | 85% | **+41.7%** |
| RAGAS综合分 | 0.4172 | 0.5829 | **+39.8%** |

16.2%的幻觉率不是零，但已经可以投入生产使用了。剩下的16.2%主要是两类：一类是代码逻辑推断类的问题，LLM需要根据上下文推断潜在风险，这类天然容易产生"过度推断"；另一类是跨多个文件的复杂关联问题，当前检索链路确实难以覆盖所有相关上下文。

### 延迟代价

完整链路的延迟分布：

| 阶段 | P50延迟 | P95延迟 |
|------|---------|---------|
| AST分块（索引时，不影响在线） | - | - |
| 混合检索（BM25+FAISS） | 80ms | 150ms |
| RRF融合 | 5ms | 10ms |
| LLM Rerank | 600ms | 800ms |
| 生成（Qwen2.5-Coder） | 1.8s | 2.5s |
| 后处理验证 | 50ms | 100ms |
| **完整链路** | **2.5s** | **3.6s** |

对比纯LLM直接回答（不做RAG）的P95延迟约1.5s，RAG链路慢了约2s。这2s主要花在LLM Rerank上。

### 成本代价

每次代码审查的LLM调用次数：

1. **Rerank调用**：1次（20个chunk的相关性评分）
2. **生成调用**：1次（基于Top-5 chunk生成审查意见）
3. **验证调用**：0次（后处理验证是纯代码逻辑，不需要LLM）

所以每次审查需要2次LLM调用。在vLLM部署的Qwen2.5-Coder上，单次审查的GPU推理时间约2.5s。

### 哪些场景不值得做

不是所有代码审查都需要这么重的RAG链路。经过实践总结：

| 场景 | 是否需要RAG | 原因 |
|------|-------------|------|
| 代码风格检查 | 不需要 | 直接在prompt里放规则就行 |
| 通用安全漏洞检测 | 不需要 | LLM训练知识足够 |
| 内部API使用正确性 | **需要** | 外部LLM不了解内部API |
| 跨文件逻辑一致性 | **需要** | 必须检索其他文件的上下文 |
| 编码规范合规检查 | **需要** | 规范文档是内部的 |
| 业务逻辑审查 | **需要** | 必须理解业务上下文 |

简单来说，**如果LLM的训练知识能覆盖的，就不用RAG；只有当信息是私有的、内部的、最新的，才值得上RAG**。

---

## 八、写在最后

回过头看这三个月的工作，最大的体会是：**RAG不是一个算法问题，是一个工程问题**。

分块怎么切才不会破坏代码结构？检索怎么融合才能兼顾关键词和语义？排序怎么权衡精确和召回？生成怎么约束才能让LLM不编？评估怎么量化才能指导优化方向？

每一个问题都不是靠某个论文里的算法就能解决的，都需要结合具体场景反复调试、量化验证、权衡取舍。

还有一个重要体会：**最重要的不是某一层有多强，而是五层叠加后的系统效应**。AST分块单独只降了10个百分点的幻觉率，混合检索又降了7个，Rerank降了2.5个，生成约束降了1.7个——每一层看起来都不算惊艳，但四层叠加后从46%降到了16.2%。这就是工程的力量——**不追求单点突破，追求系统性的逐步收敛**。

最后，**评估体系比优化技巧更重要**。没有RAGAS量化评估，v16到v20的每一次改动我都只能凭感觉判断效果。有了量化数据，我知道AST分块主要提升了Context Precision，混合检索主要提升了Context Recall，每一层优化对应哪个维度的改善，一目了然。没有评估，你根本不知道改进了是有用还是有害——甚至可能你在优化检索的时候，生成质量反而下降了，而你浑然不知。

做RAG和做模型训练很像：**你无法优化你无法度量的东西**。先把尺子造好，再去砍柴。

---

> *本文基于深信服AI Code Copilot项目的实际工程经验。所有模型均通过vLLM私有化部署Qwen2.5-Coder，不涉及外部API调用。文中代码为简化版本，仅展示核心逻辑。*
