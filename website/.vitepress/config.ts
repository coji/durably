import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Durably',
  description: 'Step-oriented resumable batch execution for Node.js and browsers',
  base: '/durably/',

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/durably/logo.svg' }]],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
    },
    ja: {
      label: '日本語',
      lang: 'ja',
      themeConfig: {
        nav: [
          { text: 'ガイド', link: '/ja/guide/getting-started' },
          { text: 'API', link: '/ja/api/' },
          { text: 'デモ', link: 'https://durably-demo.vercel.app' },
        ],
        sidebar: {
          '/ja/guide/': [
            {
              text: 'はじめに',
              items: [
                { text: 'Durablyとは？', link: '/ja/guide/' },
                { text: 'はじめる', link: '/ja/guide/getting-started' },
              ],
            },
            {
              text: 'コアコンセプト',
              items: [
                { text: 'ジョブとステップ', link: '/ja/guide/jobs-and-steps' },
                { text: '再開可能性', link: '/ja/guide/resumability' },
                { text: 'イベント', link: '/ja/guide/events' },
              ],
            },
            {
              text: 'プラットフォーム',
              items: [
                { text: 'Node.js', link: '/ja/guide/nodejs' },
                { text: 'ブラウザ', link: '/ja/guide/browser' },
                { text: 'React', link: '/ja/guide/react' },
                { text: 'デプロイ', link: '/ja/guide/deployment' },
              ],
            },
          ],
          '/ja/api/': [
            {
              text: 'APIリファレンス',
              items: [
                { text: '概要', link: '/ja/api/' },
                { text: 'createDurably', link: '/ja/api/create-durably' },
                { text: 'defineJob', link: '/ja/api/define-job' },
                { text: 'Step', link: '/ja/api/step' },
                { text: 'イベント', link: '/ja/api/events' },
              ],
            },
          ],
        },
        footer: {
          message: 'MITライセンスの下で公開されています。',
          copyright: 'Copyright 2025-present coji',
        },
      },
    },
  },

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/' },
      { text: 'Demo', link: 'https://durably-demo.vercel.app' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Durably?', link: '/guide/' },
            { text: 'Getting Started', link: '/guide/getting-started' },
          ],
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'Jobs and Steps', link: '/guide/jobs-and-steps' },
            { text: 'Resumability', link: '/guide/resumability' },
            { text: 'Events', link: '/guide/events' },
          ],
        },
        {
          text: 'Platforms',
          items: [
            { text: 'Node.js', link: '/guide/nodejs' },
            { text: 'Browser', link: '/guide/browser' },
            { text: 'React', link: '/guide/react' },
            { text: 'Deployment', link: '/guide/deployment' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'createDurably', link: '/api/create-durably' },
            { text: 'defineJob', link: '/api/define-job' },
            { text: 'Step', link: '/api/step' },
            { text: 'Events', link: '/api/events' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/coji/durably' },
      { icon: 'x', link: 'https://x.com/techtalkjp' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2025-present coji',
    },

    search: {
      provider: 'local',
    },
  },
})
