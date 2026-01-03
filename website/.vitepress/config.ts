import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Durably',
  description: 'Step-oriented resumable batch execution for Node.js and browsers',
  base: '/durably/',

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/durably/logo.svg' }]],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'API', link: '/api/' },
      { text: 'Demo', link: 'https://durably-demo.vercel.app' },
      { text: 'llms.txt', link: '/durably/llms.txt' },
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
          text: 'Use Cases',
          items: [
            { text: 'CSV Import (Full-Stack)', link: '/guide/csv-import' },
            { text: 'Offline App (Browser)', link: '/guide/offline-app' },
            { text: 'Background Sync (Server)', link: '/guide/background-sync' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Core Concepts', link: '/guide/concepts' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'Core API',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'createDurably', link: '/api/create-durably' },
            { text: 'defineJob', link: '/api/define-job' },
            { text: 'Step', link: '/api/step' },
            { text: 'Events', link: '/api/events' },
          ],
        },
        {
          text: 'React API',
          items: [
            { text: 'Overview', link: '/api/durably-react/' },
            { text: 'Browser Mode', link: '/api/durably-react/browser' },
            { text: 'Server Mode', link: '/api/durably-react/client' },
            { text: 'Types', link: '/api/durably-react/types' },
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
