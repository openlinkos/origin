import { defineOpenLinkOSConfig } from '@openlinkos/vitepress-theme/config';

const repo = 'https://github.com/openlinkos/origin';

export default defineOpenLinkOSConfig({
  brand: 'origin',
  hostname: 'https://origin.openlinkos.com',
  title: 'Origin',
  lastUpdated: false,
  srcExclude: ['**/README.md'],
  themeConfig: {
    socialLinks: [{ icon: 'github', link: repo }],
  },
  locales: {
    root: {
      description: 'Local-first, cross-agent personal memory for AI coding agents.',
      themeConfig: {
        footer: { message: 'Released under the MIT License.' },
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'Architecture', link: '/architecture' },
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
      description: '本地优先、跨 Agent 的个人记忆，服务于 AI 编码 Agent。',
      themeConfig: {
        footer: { message: '基于 MIT 许可证发布。' },
        nav: [
          { text: '指南', link: '/zh/guide/getting-started' },
          { text: '架构', link: '/zh/architecture' },
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
            text: '参考',
            items: [
              { text: '架构', link: '/zh/architecture' },
              { text: '会话来源', link: '/zh/sources' },
            ],
          },
        ],
      },
    },
  },
});
