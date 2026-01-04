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
          backgroundColor: '#0f172a',
          backgroundImage:
            'radial-gradient(circle at 25% 25%, #1e293b 0%, transparent 50%), radial-gradient(circle at 75% 75%, #1e3a5f 0%, transparent 50%)',
          padding: '60px',
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                marginBottom: '20px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '80px',
                      fontWeight: 700,
                      color: '#ffffff',
                      letterSpacing: '-2px',
                    },
                    children: 'Durably',
                  },
                },
              ],
            },
          },
          {
            type: 'div',
            props: {
              style: {
                fontSize: '32px',
                fontWeight: 600,
                color: '#94a3b8',
                marginBottom: '40px',
              },
              children: 'Resumable Batch Execution',
            },
          },
          {
            type: 'div',
            props: {
              style: {
                fontSize: '28px',
                color: '#60a5fa',
                textAlign: 'center',
                maxWidth: '900px',
              },
              children: 'Resumable jobs with just SQLite. No Redis required.',
            },
          },
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                marginTop: '50px',
                gap: '40px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      color: '#e2e8f0',
                      fontSize: '22px',
                    },
                    children: '🚀 Zero Infrastructure',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      color: '#e2e8f0',
                      fontSize: '22px',
                    },
                    children: '🔄 Resumable',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      color: '#e2e8f0',
                      fontSize: '22px',
                    },
                    children: '🌐 Browser + Server',
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
