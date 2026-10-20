import { defineConfig } from 'vitepress';

const repo = 'https://github.com/openlinkos/origin';

export default defineConfig({
  title: 'Origin',
  description: 'Local-first, cross-agent personal memory for AI coding agents.',
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ['**/README.md'],
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    footer: {
      message: 'Released under the MIT License.',
      copyright: '© 2026 OpenLinkOS',
    },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'OpenLinkOS', link: 'https://openlinkos.com' },
        ],
        sidebar: [
          {
            text: 'Guide',
            items: [
              { text: 'Getting started', link: '/guide/getting-started' },
              { text: 'Connect your agents', link: '/guide/connect-agents' },
              { text: 'Personal hub', link: '/guide/hub' },
              { text: 'CLI reference', link: '/guide/cli' },
              { text: 'Privacy and your data', link: '/guide/privacy' },
            ],
          },
          {
            text: 'Reference',
            items: [
              { text: 'Architecture', link: '/architecture' },
              { text: 'Session sources', link: '/sources' },
            ],
          },
        ],
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      description: '本地优先、跨 Agent 的个人记忆，服务于 AI 编码 Agent。',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started' },
          { text: '架构（英文）', link: '/architecture' },
          { text: 'OpenLinkOS', link: 'https://openlinkos.com/zh/' },
        ],
        sidebar: [
          {
            text: '指南',
            items: [
              { text: '快速开始', link: '/zh/guide/getting-started' },
              { text: '接入 Agent', link: '/zh/guide/connect-agents' },
              { text: '个人中枢', link: '/zh/guide/hub' },
              { text: '命令参考', link: '/zh/guide/cli' },
              { text: '隐私与数据', link: '/zh/guide/privacy' },
            ],
          },
          {
            text: '参考（英文）',
            items: [
              { text: '架构', link: '/architecture' },
              { text: '会话来源', link: '/sources' },
            ],
          },
        ],
        outline: { label: '本页内容' },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '外观',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '回到顶部',
        langMenuLabel: '语言',
      },
    },
  },
});
