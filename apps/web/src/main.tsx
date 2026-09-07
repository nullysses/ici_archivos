import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App } from './App.js';

const queryClient = new QueryClient();
const theme = createTheme({
  palette: {
    background: { default: '#f4f6f8' },
    primary: { main: '#17324d' },
    secondary: { main: '#9d7a32' },
  },
  typography: { fontFamily: 'Inter, system-ui, sans-serif' },
});
const router = createBrowserRouter([{ path: '/', element: <App /> }]);
const root = document.getElementById('root');

if (root === null) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
