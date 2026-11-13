import { createRoot } from 'react-dom/client';
import { Shell } from './shell/shell';
import { applyTheme, readTheme } from './shell/theme';
import './theme-tokens.css';
import './styles.css';
applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<Shell/>);
