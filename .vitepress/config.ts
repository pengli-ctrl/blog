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
          text: '📂 全部文章',
          items: [
            { text: '🏗️ 架构设计', link: '/posts/architecture' },
            { text: '🤖 AI Agent 专栏', link: '/posts/ai-agent' },
          ]
        }
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
    // 忽略非 HTML 资源链接（如 .drawio, .pdf 等静态文件）
    /^\/.*\.(drawio|pdf|zip)$/,
  ],

  // Markdown 增强
  markdown: {
    lineNumbers: true,
  }
})
