import { getCurrentWindow } from '@tauri-apps/api/window';
import { Bubble } from './components/Bubble';
import { QrOverlay } from './components/QrOverlay';
import { Control } from './components/Control';
import { Diagnostics } from './components/Diagnostics';
import { Setup } from './components/Setup';

type WindowKind = 'bubble' | 'qr-overlay' | 'control' | 'diagnostics' | 'setup';

const WINDOW_LABELS: readonly WindowKind[] = ['qr-overlay', 'control', 'diagnostics', 'setup'];

/** Each window loads the same bundle; render by window label. */
function currentWindowKind(): WindowKind {
  try {
    const label = getCurrentWindow().label;
    if ((WINDOW_LABELS as readonly string[]).includes(label)) return label as WindowKind;
    return 'bubble';
  } catch {
    // Running outside Tauri (e.g. plain `vite`) — preview the bubble.
    return 'bubble';
  }
}

export function App() {
  switch (currentWindowKind()) {
    case 'qr-overlay':
      return <QrOverlay />;
    case 'control':
      return <Control />;
    case 'diagnostics':
      return <Diagnostics />;
    case 'setup':
      return <Setup />;
    default:
      return <Bubble />;
  }
}
