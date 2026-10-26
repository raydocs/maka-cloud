import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/astryx.css';
import '@fontsource-variable/inter';
import { App } from './App';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </ThemeProvider>,
);
