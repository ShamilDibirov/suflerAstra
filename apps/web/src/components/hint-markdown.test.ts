import { expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HintMarkdown } from './hint-markdown';
it('renders readable emphasis and lists but no HTML, images or arbitrary links', () => {
  const html = renderToStaticMarkup(
    React.createElement(HintMarkdown, {
      children:
        '**Вопрос**\n\n- *Уточните потребность*\n\n> Готовая фраза\n\n[ссылка](https://untrusted.example) ![картинка](https://untrusted.example/a.png)\n\n<script>alert(1)</script><img src=x onerror=alert(1)>',
    }),
  );
  expect(html).toContain('<strong>Вопрос</strong>');
  expect(html).toContain('<em>Уточните потребность</em>');
  expect(html).toContain('<blockquote');
  expect(html).not.toMatch(/<(?:script|img|a)\b/);
  expect(html).not.toContain('onerror');
});
