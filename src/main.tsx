import { createRoot } from 'react-dom/client';
import { Shell } from './shell/shell';
import { applyTheme, readTheme } from './shell/theme';
import { applyAppearance, readAppearance } from './shell/appearance';
import './theme-tokens.css';
import './styles.css';
applyTheme(readTheme());
applyAppearance(readAppearance());
createRoot(document.getElementById('root')!).render(<Shell/>);
