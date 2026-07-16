import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '彭黎的技术笔记',
  description: 'AI Agent 架构 / 后端工程化 / 技术选型复盘',
  lang: 'zh-CN',

  head: [
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['meta', { name: 'author', content: '彭黎' }],
    ['meta', { name: 'keywords', content: 'AI Agent,后端架构,技术选型,分布式,微服务' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: '彭黎的技术笔记',

    nav: [
      { text: '🏠 首页', link: '/' },
      { text: '📝 文章', link: '/posts/' },
      { text: '🔧 AI Agent 专栏', link: '/ai-agent-column' },
      { text: '👤 关于我', link: '/about' },
      { text: 'GitHub', link: 'https://github.com/pengli-ctrl' },
    ],

    sidebar: {
      '/posts/': [
        {
          text: '🏗️ 架构设计',
          collapsed: false,
          items: [
            { text: '02 · 15微服务OpenAPI平台架构实战', link: '/posts/02-openapi-platform-architecture' },
            { text: '03 · 300+接口零事故灰度迁移', link: '/posts/03-grayscale-migration-project-management' },
            { text: '04 · AI Agent 编排架构演进全记录', link: '/posts/04-agentforge-architecture-evolution' },
          ]
        },
        {
          text: '🤖 AI Agent 纵深',
          collapsed: false,
          items: [
            { text: '01 · RAG工程化：幻觉率46%→16.2%', link: '/posts/01-rag-engineering-hallucination-prevention' },
            { text: '05 · 从规则引擎到LLM动态编排', link: '/posts/05-orchestration-engine-evolution' },
            { text: '06 · 故障模式推演与容错设计', link: '/posts/06-production-failure-patterns' },
          ]
        },
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/pengli-ctrl' },
    ],

    footer: {
      message: '8年后端 + AI Agent 架构实践',
      copyright: 'Copyright © 2026 彭黎 | Powered by VitePress'
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文章',
            buttonAriaLabel: '搜索文章'
          },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清除查询条件',
            backButtonTitle: '关闭搜索',
            noResultsText: '没有结果',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            }
          }
        }
      }
    },

    outline: {
      level: [2, 3],
      label: '目录'
    },

    lastUpdated: {
      text: '最后更新于'
    },

    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    }
  },

  // GitHub Pages 部署配置
  base: '/blog/',

  ignoreDeadLinks: [
    /^\/.*\.(drawio|pdf|zip)$/,
  ],

  markdown: {
    lineNumbers: true,
  }
})
