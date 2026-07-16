# 彭黎的技术笔记

> AI Agent 架构 · 后端工程化 · 技术选型复盘

基于 [VitePress](https://vitepress.dev/) 搭建的个人技术博客，部署在 GitHub Pages。

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 本地开发（热更新）
npm run dev

# 构建生产版本
npm run build

# 预览构建结果
npm run preview
```

## 📝 文章目录

- [AI Agent 多智能体编排架构实战](./posts/04-agentforge-architecture-evolution.md) — 三版架构演进复盘

## 📂 目录结构

```
blog/
├── .vitepress/          # VitePress 配置
│   ├── config.ts        # 站点配置
│   └── theme/           # 自定义主题
├── .github/workflows/   # GitHub Pages 自动部署
├── posts/               # 文章目录
├── index.md             # 首页
├── about.md             # 关于我
└── ai-agent-column.md   # AI Agent 专栏
```

## 🌐 GitHub Pages 部署

1. 在 GitHub 创建仓库（如 `blog`）
2. 推送代码：
   ```bash
   git init
   git add .
   git commit -m "init: vitepress blog"
   git branch -M main
   git remote add origin https://github.com/你的用户名/blog.git
   git push -u origin main
   ```
3. 进入仓库 Settings → Pages → Source 选择 `GitHub Actions`
4. 推送代码后自动触发部署，几分钟后访问 `https://你的用户名.github.io/blog/`

## 📌 技术栈

- VitePress 1.6+
- Vue 3
- Markdown + MDX
