import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/astryx.css';
import { App } from './App';
import './styles.css';

declare const __MOCK__: boolean;
createRoot(document.getElementById('root')!).render(
  <App initialToken={__MOCK__ ? 'demo-invite' : ''} />,
);
