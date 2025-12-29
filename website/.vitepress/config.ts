import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Durably',
  description: 'Step-oriented resumable batch execution for Node.js and browsers',
  base: '/durably/',

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/durably/logo.svg' }]],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
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
          items: [{ text: 'durably-react', link: '/api/durably-react' }],
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
