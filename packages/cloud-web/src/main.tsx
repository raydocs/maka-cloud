import { BRAND } from '@maka-cloud/client';
import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/astryx.css';
import '@fontsource-variable/inter';
import { App } from './App';
import { ThemeProvider } from './theme';
import './styles.css';

// index.html carries the same title for the first paint; this keeps the tab right after a rename.
document.title = `${BRAND.name} — ${BRAND.tagline}`;

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
