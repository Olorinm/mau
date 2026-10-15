import { readFileSync } from 'node:fs';
export const consumerHtml =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>';
export const consumerEntry = readFileSync(new URL('../demo/main.jsx', import.meta.url), 'utf8');
