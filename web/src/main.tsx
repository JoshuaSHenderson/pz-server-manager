import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// Order matters the same way it did in the single-file UI: tokens first, then layout, then the
// pieces, then the responsive overrides last so they win.
import './styles/tokens.css'
import './styles/layout.css'
import './styles/cards.css'
import './styles/controls.css'
import './styles/data.css'
import './styles/features.css'
import './styles/responsive.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
