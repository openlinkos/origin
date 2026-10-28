import { readFileSync } from 'node:fs';
import { defineOpenLinkOSConfig } from '@openlinkos/vitepress-theme/config';

const repo = 'https://github.com/openlinkos/origin';
const npm = 'https://www.npmjs.com/package/@openlinkos/origin';

/** The released version these docs describe: the CLI's, which every package shares. */
const { version } = JSON.parse(
  readFileSync(new URL('../../packages/cli/package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineOpenLinkOSConfig({
  brand: 'origin',
  hostname: 'https://origin.openlinkos.com',
  title: 'Origin',
  lastUpdated: false,
  srcExclude: ['**/README.md'],
  themeConfig: {
    socialLinks: [{ icon: 'github', link: repo }],
  },
  legal: [
    {
      text: { en: 'Privacy', zh: '隐私说明' },
      link: { en: 'https://linkos.io/privacy', zh: 'https://linkos.io/zh/privacy' },
    },
    { text: { en: 'MIT License', zh: 'MIT 许可证' }, link: `${repo}/blob/master/LICENSE` },
  ],
  locales: {
    root: {
      description: 'Local-first, cross-agent personal memory for AI coding agents.',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          {
            text: 'Reference',
            items: [
              { text: 'CLI', link: '/guide/cli' },
              { text: 'MCP tools', link: '/guide/mcp' },
              { text: 'Architecture', link: '/architecture' },
              { text: 'Session sources', link: '/sources' },
            ],
          },
          {
            text: `v${version}`,
            items: [
              { text: 'Changelog', link: '/changelog' },
              { text: 'Upgrading', link: '/guide/upgrading' },
              { text: 'Releases', link: `${repo}/releases` },
              { text: 'npm', link: npm },
            ],
          },
        ],
        sidebar: [
          {
            text: 'Guide',
            items: [
              { text: 'Getting started', link: '/guide/getting-started' },
              { text: 'Concepts', link: '/guide/concepts' },
              { text: 'Connect your agents', link: '/guide/connect-agents' },
              { text: 'Recall', link: '/guide/recall' },
              { text: 'Personal hub', link: '/guide/hub' },
              { text: 'Admin UI', link: '/guide/admin' },
              { text: 'Privacy and your data', link: '/guide/privacy' },
              { text: 'Upgrading', link: '/guide/upgrading' },
              { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            ],
          },
          {
            text: 'Reference',
            items: [
              { text: 'CLI', link: '/guide/cli' },
              { text: 'MCP tools', link: '/guide/mcp' },
              { text: 'Architecture', link: '/architecture' },
              { text: 'Session sources', link: '/sources' },
              { text: 'Changelog', link: '/changelog' },
            ],
          },
        ],
      },
    },
    zh: {
      description: '本地优先、跨 Agent 的个人记忆，服务于 AI 编码 Agent。',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started' },
          {
            text: '参考',
            items: [
              { text: '命令行', link: '/zh/guide/cli' },
              { text: 'MCP 工具', link: '/zh/guide/mcp' },
              { text: '架构', link: '/zh/architecture' },
              { text: '会话来源', link: '/zh/sources' },
            ],
          },
          {
            text: `v${version}`,
            items: [
              { text: '更新日志', link: '/zh/changelog' },
              { text: '升级', link: '/zh/guide/upgrading' },
              { text: '发布页', link: `${repo}/releases` },
              { text: 'npm', link: npm },
            ],
          },
        ],
        sidebar: [
          {
            text: '指南',
            items: [
              { text: '快速开始', link: '/zh/guide/getting-started' },
              { text: '核心概念', link: '/zh/guide/concepts' },
              { text: '接入 Agent', link: '/zh/guide/connect-agents' },
              { text: '召回', link: '/zh/guide/recall' },
              { text: '个人中枢', link: '/zh/guide/hub' },
              { text: '管理界面', link: '/zh/guide/admin' },
              { text: '隐私与数据', link: '/zh/guide/privacy' },
              { text: '升级', link: '/zh/guide/upgrading' },
              { text: '常见问题', link: '/zh/guide/troubleshooting' },
            ],
          },
          {
            text: '参考',
            items: [
              { text: '命令行', link: '/zh/guide/cli' },
              { text: 'MCP 工具', link: '/zh/guide/mcp' },
              { text: '架构', link: '/zh/architecture' },
              { text: '会话来源', link: '/zh/sources' },
              { text: '更新日志', link: '/zh/changelog' },
            ],
          },
        ],
      },
    },
  },
});
