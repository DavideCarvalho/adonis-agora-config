import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../agora-kit/fonts';
import { ThemeProvider } from '../agora-kit/theme';
import { App, CONFIG_ACCENT } from './App';
import './index.css';

/**
 * Refetch every 15s: configuration changes when someone edits it, and a second screen (another
 * operator, a rollback) should catch up without a reload. The entry editor opts out of nothing:
 * a save invalidates the lists explicitly.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 15_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider storageKey="agora-config-theme" accent={CONFIG_ACCENT}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
