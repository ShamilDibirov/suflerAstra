'use client';
import { Streamdown } from 'streamdown';
/** One restricted renderer for every assistant surface, including PiP. */
export function HintMarkdown({ children }: { children: string }) {
  return (
    <div className="hint-markdown">
      <Streamdown
        mode="static"
        components={{ strong: ({ children }) => <strong>{children}</strong> }}
        skipHtml
        allowedElements={['p', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'br']}
        unwrapDisallowed
      >
        {children}
      </Streamdown>
    </div>
  );
}
