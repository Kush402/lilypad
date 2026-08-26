import { getCurrentWindow } from '@tauri-apps/api/window';
import { Bubble } from './components/Bubble';
import { QrOverlay } from './components/QrOverlay';
import { Control } from './components/Control';
import { Diagnostics } from './components/Diagnostics';
import { Setup } from './components/Setup';
import { ErrorBoundary } from './components/ErrorBoundary';

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

function windowContent(kind: WindowKind) {
  switch (kind) {
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

export function App() {
  const kind = currentWindowKind();
  // Per window rather than once around everything, because each window mounts
  // this bundle separately: a boundary here names the window that failed, and
  // a failure in one cannot take out another that is not even in the same
  // webview.
  return <ErrorBoundary where={kind}>{windowContent(kind)}</ErrorBoundary>;
}
