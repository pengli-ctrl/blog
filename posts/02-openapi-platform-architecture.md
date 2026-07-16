---
title: "一个15微服务OpenAPI平台的架构实战：分库分表、分布式事务与300+接口灰度迁移"
description: "从0到1搭建15+微服务OpenAPI平台的全过程：DDD领域建模、ShardingSphere分库分表写入QPS翻倍、Saga分布式事务的真实落地、双级缓存将P99从200ms降到50ms、300+接口三个月零事故灰度迁移。有数据、有踩坑、有故障复盘。"
date: 2024-03-15
tags:
  - 微服务
  - 分布式系统
  - 分库分表
  - DDD
  - 灰度迁移
---

# 一个15微服务OpenAPI平台的架构实战：分库分表、分布式事务与300+接口灰度迁移

## 一、开篇：一个烂摊子和一个大胆的决定

2021年下半年，深信服内部的API管理基本处于"各自为政"的状态。

安全产品线有自己的对外接口，云计算产品线有自己的，超融合也是。每个团队自己定义入参出参、自己搞鉴权、自己处理限流。没有统一的签名规范，没有统一的错误码，没有统一的调用审计。最夸张的时候，一个业务方想调三个不同产品线的接口，需要集成三个不同的SDK，处理三种不同的鉴权方式。

安全合规那边也炸了——审计部门要求所有对外接口必须有完整的调用日志和操作留痕，但当时连统一日志格式都没有，每次审计都靠各个团队手动导出日志再拼数据。

于是，2021年Q4，正式立项统一OpenAPI平台。

我是这个项目的owner，从架构设计到开发落地全程负责。目标很明确：

1. 把散落在各产品线的300+个对外接口统一收口到一个平台
2. 支撑500+内部业务方的稳定调用
3. 实现统一的鉴权、限流、计费、审计
4. 性能不能比现有方案差，最好能好不少

听起来是个标准的"中台"故事对吧？但实际做起来，坑比想象的多得多。

最终这个平台演进到15+微服务，覆盖API管理、调用方管理、计费、审计、网关策略等多个领域。核心指标：

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| 整体QPS | 5K | 20K |
| P99延迟 | 200ms | 50ms |
| 可用性 | 95% | 99.99% |
| 业务方接入时间 | 2天 | 30分钟 |
| 写入QPS（日志） | 1K | 2.5K |

这篇文章会把核心的技术决策和踩过的坑摊开来讲。不搞那种"架构演进三部曲"的叙事套路，就聊实际遇到的问题、为什么这么选、选了之后付出了什么代价。

## 二、领域建模：DDD怎么落地（不是画几个框）

### 从业务域到限界上下文

项目启动后第一件事就是做领域建模。当时最大的诱惑是把所有东西塞进一个大单体里——毕竟逻辑上都是"API管理"嘛。但300+接口、500+业务方、还要兼顾计费和审计，单体扛不住，也演进不动。

我花了大概两周时间，和各个产品线的技术负责人做了一轮深度访谈，搞清楚了几个核心问题：

- 谁在调用API？调用方是谁、什么角色、什么权限？
- 一次API调用经过了哪些环节？鉴权、限流、路由、计费、日志。
- 哪些是核心域、哪些是支撑域、哪些是通用域？

最终划分了五个限界上下文：

```
┌─────────────────────────────────────────────────┐
│                OpenAPI Platform                  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ API管理  │  │调用方管理│  │   计费服务   │  │
│  │  (核心域) │  │ (核心域) │  │  (支撑域)    │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│                                                  │
│  ┌──────────┐  ┌──────────┐                     │
│  │ 审计日志 │  │ 网关策略 │                     │
│  │ (支撑域) │  │ (通用域) │                     │
│  └──────────┘  └──────────┘                     │
└─────────────────────────────────────────────────┘
```

### 聚合根设计

以API管理这个限界上下文为例，核心聚合根是`API`：

```java
// 简化的聚合根
public class APIAggregate {
    private APIId id;
    private String apiName;
    private List<APIVersion> versions;       // API版本列表
    private RoutingStrategy routing;          // 路由策略
    private RateLimitRule rateLimitRule;      // 限流规则
    private APIStatus status;                 // 状态：草稿/灰度/发布/下线
    
    // 聚合根保证一致性边界
    public void publish(VersionId versionId) {
        // 版本发布前的校验逻辑
        validateRouting();
        validateRateLimit();
        this.status = APIStatus.PUBLISHED;
        // 领域事件
        raise(new APIPublishedEvent(this.id, versionId));
    }
}
```

一个API不是一个简单的接口定义，它包含了版本、路由策略、限流规则，这些都属于同一个一致性边界。你不会希望API的版本是v3但路由策略还是v2的，对吧？

### 踩坑：限界上下文划得太细

说实话，DDD最初落地的时我犯了个典型错误——**拆得太细**。

一开始我把"限流策略"单独拆成了一个独立的限界上下文，觉得它是一个通用域，应该独立管理。结果呢？API发布的时候需要同时调用API管理服务创建版本、调用限流策略服务创建规则、调用网关策略服务下发配置，一条链路串了三个服务，事务边界变得极其复杂。

后来复盘的时候意识到：限流规则的生命周期和API是强绑定的。API创建它就创建，API下线它就下线。它不是一个独立的领域概念，而是API聚合的一部分。

于是把限流策略合并回了API管理这个限界上下文，网关策略那个上下文只负责最终的路由规则下发和流量管控。这一合并，跨服务调用链路短了，事务一致性也好了很多。

**教训：DDD的限界上下文不是越细越好。判断标准是两个概念是否有独立的生命周期和独立的业务含义。**如果A变了B一定要跟着变，那它们大概率应该在同一个上下文里。

## 三、分库分表：ShardingSphere实战

### 为什么要分

这个平台有个核心需求：每一次API调用都要记录审计日志。500+业务方、300+接口，峰值QPS 5K的时候，日志表的增长速度是每天300万行。

到了2022年年中，`api_call_log`单表突破5000万行。问题开始出现：

- 按时间范围查询的P99延迟超过800ms，审计后台的日志查询页面被投诉了无数次
- 单次全表统计（比如按月统计各业务方的调用量）需要跑几分钟
- 数据库磁盘使用率已经到了70%，按这个增长曲线，半年后就会撑满

分库分表势在必行。

### 分片策略的选择

分片键的选择是整个分库分表方案里最关键的决策。

**最初我选了`api_id`作为分片键。**理由很直觉：审计查询大部分是按"某个API的调用情况"来查的。

上线后才发现这是个大坑。

我们有两个超级大客户，他们的核心业务依赖某几个高频API，这几个API的调用量占了总量的40%。数据全部打到了同一个分片上，那个分片的CPU长期90%+，而其他分片利用率不到20%。典型的热点分片问题。

**后来改成了`tenant_id`（业务方ID）作为分片键。**原因是业务方维度的流量分布相对均匀——500+业务方哈希到8个库，每个库的负载基本持平。

代价是：按api_id查询的时候，需要扫描所有分片再归并。但实际场景中，按业务方查日志的需求远大于按单个API查，这个trade-off是值的。

### 具体分片方案

采用ShardingSphere-JDBC，8库 × 按月分表：

```yaml
# ShardingSphere 分片配置（简化版）
spring:
  shardingsphere:
    datasource:
      names: ds0,ds1,ds2,ds3,ds4,ds5,ds6,ds7
    sharding:
      tables:
        api_call_log:
          # 分库策略：tenant_id哈希取模
          actual-data-nodes: ds$->{0..7}.api_call_log_$->{2022..2025}$->{(1..12).collect{it.toString().padLeft(2,'0')}}
          database-strategy:
            standard:
              sharding-column: tenant_id
              sharding-algorithm-name: tenant-hash
          table-strategy:
            standard:
              sharding-column: create_time
              sharding-algorithm-name: month-range
          # 跨库路由：按tenant_id精确定库，按时间范围定位表
      sharding-algorithms:
        tenant-hash:
          type: HASH_MOD
          props:
            sharding-count: "8"
        month-range:
          type: INTERVAL
          props:
            datetime-pattern: "yyyy-MM-dd HH:mm:ss"
            datetime-lower: "2022-01-01 00:00:00"
            datetime-upper: "2026-01-01 00:00:00"
            sharding-suffix-pattern: "yyyyMM"
            datetime-interval-amount: "1"
            datetime-interval-unit: MONTHS
```

最终分片后的表命名类似：`ds3.api_call_log_202401`，某个租户在2024年1月的调用日志。

### 跨分片查询的处理

审计后台是个头疼的问题。审计人员需要按时间范围查全量日志，不关心是哪个租户的，这就意味着要跨所有分片查询。

我采用了两个策略：

**第一，在线查询只保留近期数据。**审计后台的实时查询界面只查最近7天的数据，并且限制单次查询的时间跨度不超过24小时。这样查询范围限定在7天 × 8库 = 56个分片表，用ShardingSphere的归并查询还能扛住。

**第二，历史数据走异步导出。**超过7天的查询，走异步导出流程：提交导出任务 → 后台分片并行查询 → 结果归并 → 生成CSV → 通知下载。这个异步通道走的是离线计算，不影响在线服务。

```java
// 异步导出的核心逻辑
public void exportAsync(AuditQueryRequest request) {
    // 1. 解析查询条件，确定涉及的分片
    List<ShardingRoute> routes = shardingRouter.parse(request);
    
    // 2. 提交并行查询任务
    List<CompletableFuture<List<CallLog>>> futures = routes.stream()
        .map(route -> CompletableFuture.supplyAsync(
            () -> logRepository.queryByRoute(route, request),
            exportExecutor  // 独立的线程池，不影响在线服务
        ))
        .collect(Collectors.toList());
    
    // 3. 归并结果，写入临时文件
    CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
        .thenApply(f -> mergeAndExport(f, request));
}
```

### 写入QPS从1K到2.5K

分片本身解决了单库写入瓶颈，但光分片不够。1K → 2.5K还靠了这几个优化：

**批量写入。**原来是一条日志一次INSERT，改成异步攒批，每200ms或累积500条写入一次。ShardingSphere会根据分片键自动路由到不同的库，攒批的时候先在内存里按目标分片分组，然后每个分片走一次batch INSERT。

**连接池调优。**默认的HikariCP配置太保守了。针对日志写入这个场景，把每个分片的连接池从10调到30，`maximumPoolSize`调大后配合连接超时从30s降到5s，快速失败比排队等待要好。

**写入异步化。**日志写入不需要同步返回。API网关处理完请求后，把日志事件丢进Kafka，消费端负责批量落库。这样API调用的响应时间完全不受日志写入的影响。

这三招下来，写入QPS从1K提升到2.5K，还有余量。

## 四、分布式事务：Saga模式的真实落地

### 场景

API发布是这个平台最复杂的操作之一。当用户在管理控制台点击"发布"按钮时，后台需要完成以下操作：

1. **API管理服务**：更新API版本状态为"已发布"
2. **网关策略服务**：下发新的路由规则到网关集群
3. **计费服务**：根据API的计费规则创建或更新计费项
4. **审计日志服务**：记录本次发布操作

这四个操作分属不同的微服务，各自有自己的数据库。它们要么全部成功，要么全部回滚——你不可能想象一个场景：API状态显示"已发布"，但网关还没下发路由规则，调用方打过来的请求全部404。

### 为什么不用2PC

说实话最初考虑过2PC。但几个原因让我放弃了：

1. **性能**。2PC的同步阻塞在4个服务之间是灾难性的。网关策略服务需要跟底层网关集群通信，延迟不可控。一旦有一个参与者超时，所有参与者都被锁住。
2. **可用性**。2PC中协调者单点问题不好解决。
3. **侵入性**。需要对每个服务的数据库支持XA协议，我们的MySQL配置和运维团队都不太配合。
4. **微服务原则**。2PC本质上是强耦合——所有参与者必须在同一个事务中完成，这和微服务的自治原则相悖。

### Saga编排式实现

最终选择了Saga模式，而且是编排式（Orchestration）而非协同式（Choreography）。

为什么用编排式？因为API发布这个流程是一个明确的、有固定顺序的业务流程，用中心协调器来控制更清晰。协同式（事件驱动）适合参与者多、流程不固定的场景，但我们这里就是4个固定步骤，用编排式更直观，也更容易做补偿。

```java
// Saga编排器
public class APIPublishSaga {
    
    @Autowired
    private APIPublishCoordinator coordinator;
    
    public void publish(APIPublishCommand command) {
        // 定义正向流程和补偿流程
        SagaDefinition definition = SagaDefinition.builder()
            .step("update_api_status")
                .invoke(apiService::publishVersion)
                .onFail(apiService::rollbackVersionStatus)
            .step("deploy_routing")
                .invoke(gatewayService::deployRouting)
                .onFail(gatewayService::rollbackRouting)
            .step("update_billing")
                .invoke(billingService::createBillingRule)
                .onFail(billingService::rollbackBillingRule)
            .step("record_audit")
                .invoke(auditService::recordPublish)
                .onFail(auditService::rollbackAuditRecord)  // 审计记录补偿
            .build();
        
        coordinator.execute(definition, command);
    }
}
```

每个服务暴露两个接口：正向操作接口和undo接口。undo接口接收和正向操作相同的参数，执行反向操作。

### 补偿机制的设计细节

补偿不是简单的"反向操作"。有几个细节需要注意：

**幂等性。**补偿操作可能因为重试被执行多次，必须幂等。我们的做法是每个操作都有唯一的`saga_id + step_id`，undo接口根据这个ID做幂等检查。

**补偿超时。**undo接口本身也可能超时。我们设置了3次重试，每次间隔翻倍（1s → 2s → 4s）。如果3次都失败，标记该步骤为"补偿失败"，进入人工介入流程。

**人工介入。**补偿失败的操作会进入一张"待处理"表，运维团队每天早上会review这张表，手动处理不一致的数据。说实话，这张表有数据是正常的——分布式事务嘛，不可能100%自动化解决所有问题。

### 一个真实的故障case

2023年3月的一个下午，一个核心API的发布操作出了问题。

正向流程执行到第3步——计费服务创建计费规则的时候，超时了。原因是计费服务在做一次数据库DDL（后来发现是运维没通知我们），导致连接池耗尽。

协调器检测到超时，触发补偿流程：先补偿第3步（不需要，因为没成功），再补偿第2步（回滚路由规则），再补偿第1步（回滚API状态）。

第2步补偿成功了。但第1步——回滚API状态——也超时了。因为API管理服务同一时间在做一次发布（另一个团队在发布另一个API），数据库也受影响了。

结果就是：API状态显示"已发布"（第1步正向成功但补偿失败），但路由规则已经被回滚了（第2步补偿成功）。调用方打过来的请求能找到API，但路由不到后端服务。

这个不一致持续了大约40分钟，直到运维发现告警，手动把路由规则重新下发、把API状态回滚。

**复盘的结论：**

1. 补偿接口也需要和正向接口一样的资源保障。我们不能假设"补偿是小概率事件所以可以降低资源"——恰恰相反，当正向操作因为资源不足失败的时候，补偿操作也面临同样的资源问题。
2. 必须有对账任务兜底。我们后来加了一个定时对账任务，每5分钟扫描一次：检查所有"已发布"状态的API，是否都有对应的路由规则和计费规则。如果不一致，自动告警。
3. DDL必须走变更流程通知。那次事故的根因是运维做DDL没通知开发团队。

### Saga不是银弹

说句大实话：Saga的补偿逻辑复杂度不亚于正向逻辑。你需要为每一个正向操作设计一个可靠的undo操作，还要处理补偿失败的情况。

我的经验是：

- **能避免分布式事务就避免。**如果业务上可以接受最终一致性，用消息队列+对账任务可能比Saga更简单。
- **补偿逻辑必须测试。**我们后来给每个undo接口都写了集成测试，模拟各种超时、失败场景。
- **对账任务是最后一道防线。**必须有，不能省。

## 五、缓存架构：双级缓存+布隆过滤器

### 查询链路的痛点

平台的鉴权和路由环节需要高频查询API的元数据——包括API密钥对应的租户信息、路由规则、限流配置等。这些数据读多写少，但QPS极高，峰值时每秒有上万次查询打过来。

最初所有查询都直接走Redis Cluster。Redis的性能当然好，但在峰值期间，单次查询的网络开销（应用服务器到Redis集群的RTT）加上序列化/反序列化的开销，累积起来也撑到了P99 200ms。

更关键的是，我们有一个超级大客户，单个API key的查询量占了总查询量的30%。这意味着Redis有大量带宽被同一个key的查询占用了。

### 三级查询链路

改造后的查询链路：

```
请求 → Caffeine本地缓存(5min TTL)
         ↓ miss
       Redis Cluster
         ↓ miss  
       数据库
         ↓ 回填缓存
```

```java
// 三级缓存查询逻辑
public APIConfig getConfig(String apiKey) {
    // L1: Caffeine本地缓存
    APIConfig config = localCache.getIfPresent(apiKey);
    if (config != null) {
        return config;
    }
    
    // L2: Redis Cluster
    config = redisTemplate.opsForValue().get("api:config:" + apiKey);
    if (config != null) {
        localCache.put(apiKey, config);  // 回填L1
        return config;
    }
    
    // L3: 数据库
    config = apiConfigRepository.findByApiKey(apiKey);
    if (config != null) {
        redisTemplate.opsForValue().set("api:config:" + apiKey, config, 
            30, TimeUnit.MINUTES);  // L2 TTL 30分钟
        localCache.put(apiKey, config);  // 回填L1
        return config;
    }
    
    // 都不存在，返回null
    return null;
}
```

### 缓存一致性策略

对于缓存一致性，我没有追求强一致——API配置这种数据，短暂的不一致是可以接受的（新配置最多延迟5分钟生效）。

但有一些底线要守住：

**写时失效 + 延迟双删。**更新API配置时：
1. 先删除本地缓存
2. 更新数据库
3. 延迟500ms再删除Redis缓存（防止并发读写导致脏数据）

```java
public void updateConfig(String apiKey, APIConfig newConfig) {
    localCache.invalidate(apiKey);           // 1. 删L1
    apiConfigRepository.update(newConfig);   // 2. 更新DB
    redisTemplate.delete("api:config:" + apiKey);  // 3. 删L2
    
    // 延迟双删：500ms后再删一次Redis
    scheduler.schedule(() -> {
        redisTemplate.delete("api:config:" + apiKey);
    }, 500, TimeUnit.MILLISECONDS);
}
```

**为什么是500ms？**因为我们数据库写入的P99在20ms以内，500ms足够覆盖绝大部分并发写操作的窗口。太长了影响更新生效的时效性，太短了覆盖不了并发窗口。

### 布隆过滤器：防缓存穿透

有个安全问题必须处理：如果有人用伪造的API key来调用接口，这个key在系统里不存在，每次查询都会穿透到数据库。恶意攻击者可以构造大量不存在的key，把数据库打挂。

解决方案是布隆过滤器：

```java
public class APIKeyFilter {
    private BloomFilter<String> bloomFilter;
    
    // 系统启动时，把所有合法的API key加载到布隆过滤器
    @PostConstruct
    public void init() {
        List<String> allApiKeys = apiConfigRepository.findAllApiKeys();
        this.bloomFilter = BloomFilter.create(
            Funnels.stringFunnel(Charset.forName("UTF-8")),
            allApiKeys.size(),    // 预估元素数量
            0.001                  // 误判率0.1%
        );
        allApiKeys.forEach(bloomFilter::put);
    }
    
    // 查询前先过布隆过滤器
    public boolean mightExist(String apiKey) {
        return bloomFilter.mightContain(apiKey);
    }
}
```

查询链路加了前置判断：

```java
public APIConfig getConfig(String apiKey) {
    // 前置：布隆过滤器拦截
    if (!apiKeyFilter.mightExist(apiKey)) {
        // 确定不存在，直接返回，不查缓存也不查DB
        throw new InvalidApiKeyException(apiKey);
    }
    // ... 正常的三级缓存查询
}
```

布隆过滤器的维护：新API key创建时，通过Redis的BF.ADD命令同步添加到分布式布隆过滤器中；每天凌晨全量重建一次，清理已下线的API key。

### 效果

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| P99延迟 | 200ms | 50ms |
| Redis QPS | ~12K | ~5K |
| DB穿透查询 | 存在风险 | 基本为零 |

本地缓存扛住了热点key的查询压力。那个大客户30%的查询量，几乎全部命中Caffeine，Redis的压力直接降了60%。

**一个trade-off：**本地缓存有5分钟的TTL，意味着新配置发布后最坏情况下5分钟才生效。对于绝大部分API配置这不是问题，但对于限流规则这种需要快速生效的配置，我们单独走了一条"紧急下发"通道——通过消息队列推送到各个网关节点，绕过缓存直接更新。

## 六、灰度迁移：300+接口三个月零事故

### 不能停服迁移

这个平台最难的部分，可能不是上面那些技术架构，而是怎么把300+个正在使用的接口从旧系统迁移到新系统。

旧系统上有500+业务方在跑着实际业务。任何一次迁移出了问题，影响的就是某个业务方的生产环境。你不可能发个通知说"今晚12点停服迁移"——业务方不会同意，产品线领导也不会同意。

必须灰度。

### 灰度策略：双写双读 → 流量比例灰度

整个过程分三个阶段：

**阶段一：双写双读（第1-4周）**

新系统上线后，所有API调用同时走旧系统和新系统。旧系统的结果返回给调用方，新系统的结果在后台和旧系统做比对。

```java
// 双写比对逻辑
public Response handleRequest(Request request) {
    // 旧系统正常处理
    Response oldResponse = oldSystem.handle(request);
    
    // 新系统异步处理，结果比对
    asyncExecutor.execute(() -> {
        Response newResponse = newSystem.handle(request);
        if (!responseComparator.equals(oldResponse, newResponse)) {
            // 差异告警
            alertService.send(DiffAlert.builder()
                .apiId(request.getApiId())
                .caller(request.getCallerId())
                .oldResponse(oldResponse)
                .newResponse(newResponse)
                .build());
        }
    });
    
    return oldResponse;  // 返回旧系统结果
}
```

这个阶段的目的不是切流量，而是验证新系统在真实流量下的表现。比对引擎会发现各种边界case——旧系统有一些隐藏的bug，新系统没有复现；新系统有一些更严格的数据校验，旧系统放过了不合法的请求。

**阶段二：按流量比例灰度（第5-12周）**

双写验证没问题后，开始按比例切流量。

```
Week 5-6:   10% 流量 → 新系统
Week 7-8:   50% 流量 → 新系统
Week 9-12:  100% 流量 → 新系统（旧系统保留，随时可回滚）
```

流量切换在网关层实现，支持两个维度的灰度：

- **按业务方维度**：先把内部工具类产品（影响面小）的业务方切过去，验证稳定后再切核心业务方
- **按API维度**：先把查询类接口（只读操作，风险低）切过去，再切写入类接口

网关层的路由权重配置：

```yaml
# 网关灰度路由配置
routes:
  - api_id: "api.user.query"
    grayscale:
      rules:
        - condition: "caller_id in [tenant_001, tenant_002]"
          target: new_system
          weight: 100       # 特定租户全量切新系统
        - condition: "default"
          target: new_system
          weight: 50        # 其他租户50%切新系统
          fallback: old_system
```

**阶段三：旧系统下线（第13周之后）**

100%流量跑了4周没问题后，旧系统进入"只读保留"状态——不再接受新的写入操作，但保留查询能力1个月，以防需要回查历史数据。

### 一个差点翻车的时刻

第3周，灰度比例从50%往100%推的时候，告警系统突然响了。

监控发现：某个核心业务方在新系统上的计费数据和旧系统不一致。具体表现为：旧系统对某个API的调用按"按量计费"规则计费，但新系统按"包月"规则计费。

排查后发现：旧系统里有一条隐藏的计费规则覆盖逻辑——当某个业务方的某个API同时命中"按量"和"包月"两条规则时，旧系统取优先级更高的那条。这个逻辑没有写在任何文档里，是当年开发时硬编码的一个特殊处理。

双写比对引擎为什么没发现？因为比对逻辑只比对了API响应，没有比对计费结果。计费是在异步流程里完成的，比对引擎没覆盖到。

处理过程：
1. 立刻将该业务方的流量比例回滚到10%
2. 在新系统里补上优先级覆盖逻辑
3. 重新跑双写比对，这次把计费结果也纳入比对范围
4. 确认一致后，继续推进灰度

这个事情耽误了一周时间。但它也暴露了一个架构问题：计费结果应该在双写比对的范围之内。后来我们补了一个"计费对账"模块，专门比对计费结果。

### 灰度最重要的不是技术

三个月零事故，技术上其实没有特别花哨的东西。真正的关键在于**沟通**。

我每周给500+业务方发一封迁移进度邮件，内容包括：

- 本周灰度比例和涉及的业务方
- 下周计划调整的比例
- 当前发现的问题和处理进展
- 回滚机制说明

每次比例调整前48小时，单独通知受影响最大的前20个业务方，确认他们已知晓并确认应急联系人。

第3周出问题回滚的时候，因为通知及时、沟通充分，业务方没有产生恐慌。反而有几个业务方主动反馈了一些他们那边的边缘case，帮助我们提前发现问题。

**如果让我给灰度迁移提一个建议：技术做得再好，沟通不到位就会出事。业务方不怕迁移，怕的是"不知道什么时候迁移、出问题了没人管"。**

## 七、工程效率：SDK自动生成

### 痛点

在统一平台之前，业务方接入一个API的典型流程是这样的：

1. 找API负责人要接口文档（通常是wiki页面或者Word文档）
2. 手写HTTP调用代码
3. 手写签名验签逻辑（每个产品线的签名算法还不一样）
4. 手写重试逻辑
5. 手写错误码映射
6. 联调、测试

整个流程下来，一个业务方接入一个API平均需要2天。如果接入多个API，工作量是线性增长的。

更离谱的是，签名验签逻辑很容易出错。最常见的联调问题就是"签名验证失败"，有时候是时间戳精度问题（秒vs毫秒），有时候是参数排序规则不对，有时候是URL编码问题。

### 解决方案

既然已经做了统一的OpenAPI平台，那就可以基于OpenAPI Spec（也就是Swagger规范）自动生成SDK。

方案：

1. 管理控制台发布API时，自动生成标准OpenAPI 3.0 Spec
2. 基于Spec，用代码生成引擎（基于OpenAPI Generator）自动生成Java、Python、Go三种语言的SDK
3. SDK内置：签名计算、请求重试（指数退避）、错误码映射、类型安全的请求/响应模型

```java
// 自动生成的SDK使用示例（Java）
// 业务方只需要写这些代码
ApiClient client = new ApiClient("https://api.example.com")
    .setApiKey("your-api-key")
    .setApiSecret("your-api-secret");

UserApi userApi = new UserApi(client);

try {
    QueryUserRequest request = new QueryUserRequest()
        .userId("12345")
        .includeDetail(true);
    
    QueryUserResponse response = userApi.queryUser(request);
    System.out.println(response.getUserName());
} catch (ApiException e) {
    // 错误码已经映射成枚举
    if (e.getErrorCode() == ErrorCode.RATE_LIMITED) {
        // 自动重试已经处理了大部分情况，走到这里说明重试了也失败
        System.out.println("请求被限流，请稍后重试");
    }
}
```

签名、重试、错误处理这些"脏活"全部封装在生成的SDK里，业务方完全不用关心。

### 效果

接入时间从2天缩短到30分钟。业务方只需要：
1. 在管理控制台申请API key（5分钟审批）
2. 在Maven/Pip/Go module中引入SDK依赖
3. 按照示例代码调用

联调阶段的签名验证失败问题基本消失了——因为签名逻辑是SDK内部自动处理的，不存在手写出错的可能。

## 八、写在最后

这个OpenAPI平台从2021年Q4立项，到2024年我离开的时候，已经稳定运行了将近3年。

15个微服务、500+业务方、300+接口、峰值QPS 20K、可用性99.99%——这些数字背后是无数个踩坑和填坑的日子。

回头看，最大的体会有几个：

**分布式系统的复杂度不在技术选型。**选ShardingSphere还是MyCat、选Saga还是TCC、选Redis还是Memcached——这些选型当然重要，但真正的复杂度在数据一致性的保证、在灰度迁移的工程管理、在各种边界case的处理。技术选型是"知道用哪个"，工程落地是"知道怎么用好"。

**对账思维很重要。**分布式环境下，不要假设任何操作是100%可靠的。每个关键环节都应该有对账机制：Saga要和对账任务配合，双写要和数据比对配合，缓存要和数据库一致性巡检配合。"信任但验证"是分布式系统的基本原则。

**DDD不是教条。**限界上下文怎么划、聚合根怎么设计，最终要服务于业务和工程实践。划得太细就合并，拆得太粗就再拆。不要为了"符合DDD规范"而做设计，要为了"解决问题"而做设计。

**沟通就是生产力。**500+业务方的灰度迁移能零事故，靠的不是什么高大上的技术方案，而是每周的进度邮件、每次调整前的48小时通知、出了问题第一时间的回滚和透明沟通。

后来我转向了AI Agent方向的工作（前面几篇文章有聊过），很多人觉得从传统分布式架构到AI是跨了一大步。但其实很多设计思路是相通的——状态管理、事件驱动、灰度策略、分布式一致性。底层的能力不会因为上层的范式变化而失效。

分布式架构这件事，没有银弹，只有trade-off。选你所承担的，承担你所选择的。

---

*这篇文章里的代码都是简化版，去掉了异常处理、监控埋点等细节，只保留核心逻辑。实际代码比这复杂得多。*

*如果你对OpenAPI平台的某个具体技术点感兴趣，欢迎讨论。*
