export const consumerEntry = `import { mountFrontend } from '@olorinm/agent-frontend';
import '@olorinm/agent-frontend/style.css';
window.frontendTestHandle = await mountFrontend(document.getElementById('root'), {
  apiBase: new URL('/fixture-api/', location.href).href,
  productName: 'Mau', storageNamespace: 'frontend-test',
  passwordLogin: new URLSearchParams(location.search).has('password-login') ? async credentials => {
    window.frontendTestCredentials = credentials;
    if (credentials.password !== ' fixture-password ') throw new Error('fixture_login_rejected');
  } : undefined,
  headers: () => ({ 'x-frontend-test': 'fixture' }),
  bootstrap: { environment: { preset: 'frontend-test-fixture' }, mcpApps: {} },
});`;
export const consumerHtml = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>';
