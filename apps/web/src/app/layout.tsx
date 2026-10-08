import type { Metadata } from 'next';
import './globals.css';
import { TooltipProvider } from '@/components/ui/tooltip';
export const metadata: Metadata = {
  title: 'Суфлёр — рядом в каждом разговоре',
  description: 'AI-помощник сотрудника телеком-розницы. Подсказки с опорой на вашу базу знаний.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
