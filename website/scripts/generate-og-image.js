import { Resvg } from '@resvg/resvg-js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Load font from GitHub
async function loadFont(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch font: ${response.status}`)
  }
  return await response.arrayBuffer()
}

async function generateOgImage() {
  // Use Noto Sans from Google Fonts (static TTF, widely available)
  const [fontRegular, fontBold] = await Promise.all([
    loadFont(
      'https://raw.githubusercontent.com/googlefonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf',
    ),
    loadFont(
      'https://raw.githubusercontent.com/googlefonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf',
    ),
  ])

  // VitePress default theme colors
  const brandColor = '#646cff' // VitePress brand purple
  const bgColor = '#1b1b1f' // VitePress dark bg
  const textColor = 'rgba(255, 255, 255, 0.87)'
  const mutedColor = 'rgba(235, 235, 245, 0.6)'

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: bgColor,
          padding: '60px',
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                fontSize: '72px',
                fontWeight: 700,
                color: textColor,
                letterSpacing: '-1px',
                marginBottom: '16px',
              },
              children: 'Durably',
            },
          },
          {
            type: 'div',
            props: {
              style: {
                fontSize: '36px',
                fontWeight: 600,
                color: brandColor,
                marginBottom: '24px',
              },
              children: 'Resumable Batch Execution',
            },
          },
          {
            type: 'div',
            props: {
              style: {
                fontSize: '28px',
                color: mutedColor,
                textAlign: 'center',
                maxWidth: '800px',
                lineHeight: 1.4,
              },
              children: 'Resumable jobs with just SQLite. No Redis required.',
            },
          },
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                marginTop: '48px',
                gap: '48px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '8px',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '20px',
                            fontWeight: 600,
                            color: textColor,
                          },
                          children: 'Zero Infrastructure',
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '14px',
                            color: mutedColor,
                          },
                          children: 'SQLite only',
                        },
                      },
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '8px',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '20px',
                            fontWeight: 600,
                            color: textColor,
                          },
                          children: 'Resumable Steps',
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '14px',
                            color: mutedColor,
                          },
                          children: 'Auto-saved progress',
                        },
                      },
                    ],
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '8px',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '20px',
                            fontWeight: 600,
                            color: textColor,
                          },
                          children: 'Browser + Server',
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '14px',
                            color: mutedColor,
                          },
                          children: 'Same API everywhere',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'Inter',
          data: fontRegular,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'Inter',
          data: fontBold,
          weight: 600,
          style: 'normal',
        },
        {
          name: 'Inter',
          data: fontBold,
          weight: 700,
          style: 'normal',
        },
      ],
    },
  )

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: 1200,
    },
  })

  const pngData = resvg.render()
  const pngBuffer = pngData.asPng()

  const outputPath = join(__dirname, '../public/og-image.png')
  writeFileSync(outputPath, pngBuffer)
  console.log(`Generated ${outputPath}`)
}

generateOgImage().catch(console.error)
