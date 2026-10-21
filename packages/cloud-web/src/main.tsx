import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/astryx.css';
import { App } from './App';
import { ThemeProvider } from './theme';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
