import { mountFrontend } from '@olorinm/agent-frontend';
import '@olorinm/agent-frontend/style.css';

// An independent consumer entry. The configured development service must implement
// the frontend contract; this example does not pretend missing Mau APIs exist.
const app = await mountFrontend(document.getElementById('root')!, {
  apiBase: new URL('/api/', location.href).href,
  productName: new URLSearchParams(location.search).get('product') ?? 'Mau',
  storageNamespace: 'mau-frontend-preview',
});

if (import.meta.hot) import.meta.hot.dispose(() => app.dispose());
