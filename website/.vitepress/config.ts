import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Durably',
  description: 'Step-oriented resumable batch execution for Node.js and browsers',
  base: '/durably/',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/durably/logo.svg' }],
    ['meta', { property: 'og:title', content: 'Durably' }],
    ['meta', { property: 'og:description', content: 'Just SQLite. No Redis required.' }],
    ['meta', { property: 'og:image', content: 'https://coji.github.io/durably/og-image.png' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Durably' }],
    ['meta', { name: 'twitter:description', content: 'Just SQLite. No Redis required.' }],
    ['meta', { name: 'twitter:image', content: 'https://coji.github.io/durably/og-image.png' }],
  ],

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
            { text: 'Core Concepts', link: '/guide/concepts' },
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
      ],
      '/api/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Quick Reference', link: '/api/' },
          ],
        },
        {
          text: 'Job Definition',
          items: [
            {
              text: 'defineJob',
              link: '/api/define-job',
              collapsed: false,
              items: [
                { text: 'trigger', link: '/api/define-job#trigger' },
                { text: 'triggerAndWait', link: '/api/define-job#triggerandwait' },
                { text: 'batchTrigger', link: '/api/define-job#batchtrigger' },
              ],
            },
            {
              text: 'Step Context',
              link: '/api/step',
              collapsed: false,
              items: [
                { text: 'step.run', link: '/api/step#run' },
                { text: 'step.progress', link: '/api/step#progress' },
                { text: 'step.log', link: '/api/step#log' },
              ],
            },
          ],
        },
        {
          text: 'Instance & Lifecycle',
          items: [
            {
              text: 'createDurably',
              link: '/api/create-durably',
              collapsed: false,
              items: [
                { text: 'init / migrate / start', link: '/api/create-durably#init' },
                { text: 'register', link: '/api/create-durably#register' },
                { text: 'on (events)', link: '/api/create-durably#on' },
                { text: 'stop', link: '/api/create-durably#stop' },
                { text: 'retry / cancel', link: '/api/create-durably#retry' },
                { text: 'getRun / getRuns', link: '/api/create-durably#getrun' },
              ],
            },
            {
              text: 'Events',
              link: '/api/events',
              collapsed: false,
              items: [
                { text: 'Run Events', link: '/api/events#run-events' },
                { text: 'Step Events', link: '/api/events#step-events' },
                { text: 'Log Events', link: '/api/events#log-events' },
                { text: 'Worker Events', link: '/api/events#worker-events' },
              ],
            },
          ],
        },
        {
          text: 'Server Integration',
          items: [
            {
              text: 'HTTP Handler',
              link: '/api/http-handler',
              collapsed: false,
              items: [
                { text: 'createDurablyHandler', link: '/api/http-handler#createdurablyhandler' },
                { text: 'Framework Integration', link: '/api/http-handler#framework-integration' },
                { text: 'Endpoints', link: '/api/http-handler#endpoints' },
                { text: 'SSE Events', link: '/api/http-handler#sse-event-stream' },
                { text: 'Security', link: '/api/http-handler#security-considerations' },
              ],
            },
          ],
        },
        {
          text: 'React Hooks',
          items: [
            { text: 'Overview', link: '/api/durably-react/' },
            {
              text: 'Browser Hooks',
              link: '/api/durably-react/browser',
              collapsed: false,
              items: [
                { text: 'DurablyProvider', link: '/api/durably-react/browser#durablyprovider' },
                { text: 'useDurably', link: '/api/durably-react/browser#usedurably' },
                { text: 'useJob', link: '/api/durably-react/browser#usejob' },
                { text: 'useJobRun', link: '/api/durably-react/browser#usejobrun' },
                { text: 'useJobLogs', link: '/api/durably-react/browser#usejoblogs' },
                { text: 'useRuns', link: '/api/durably-react/browser#useruns' },
              ],
            },
            {
              text: 'Server Hooks',
              link: '/api/durably-react/client',
              collapsed: false,
              items: [
                { text: 'createDurablyClient', link: '/api/durably-react/client#createdurablyclient' },
                { text: 'useJob', link: '/api/durably-react/client#usejob' },
                { text: 'useJobRun', link: '/api/durably-react/client#usejobrun' },
                { text: 'useJobLogs', link: '/api/durably-react/client#usejoblogs' },
                { text: 'useRuns', link: '/api/durably-react/client#useruns' },
                { text: 'useRunActions', link: '/api/durably-react/client#userunactions' },
              ],
            },
            { text: 'Type Definitions', link: '/api/durably-react/types' },
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
