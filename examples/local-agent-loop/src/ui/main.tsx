import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'

import './app.css'

// The server puts a token made for this process in the page; every action
// sends it back. A page of another site cannot read it.
const token =
  document.querySelector<HTMLMetaElement>('meta[name="loop-ui-token"]')
    ?.content ?? ''

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App token={token} />
  </StrictMode>,
)
