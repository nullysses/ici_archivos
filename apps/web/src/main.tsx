import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AdminRoute, App, ArchiveRoute, ExpedientesRoute, MattersRoute, RouteError, WorkRoute } from './App.js';
import { NotFoundState } from './ux.js';

const queryClient = new QueryClient();
const theme = createTheme({
  palette: {
    background: { default: '#f4f6f8' },
    primary: { main: '#17324d' },
    secondary: { main: '#9d7a32' },
  },
  typography: { fontFamily: 'Inter, system-ui, sans-serif', h3: { fontSize: 'clamp(1.8rem, 3vw, 2.6rem)', fontWeight: 750 }, h5: { fontWeight: 700 } },
  shape: { borderRadius: 8 },
  components: {
    MuiButtonBase: { styleOverrides: { root: { '&.Mui-focusVisible': { outline: '3px solid #9d7a32', outlineOffset: 2 } } } },
    MuiLink: { styleOverrides: { root: { '&:focus-visible': { outline: '3px solid #9d7a32', outlineOffset: 2 } } } },
  },
});
const router = createBrowserRouter([{
  path: '/',
  element: <App />,
  errorElement: <RouteError />,
  children: [
    { index: true, element: <Navigate replace to="/work" /> },
    { path: 'work', element: <WorkRoute /> },
    { path: 'matters', element: <MattersRoute /> },
    { path: 'matters/:matterId', element: <NotFoundState /> },
    { path: 'expedientes', element: <ExpedientesRoute /> },
    { path: 'expedientes/:expedienteId', element: <NotFoundState /> },
    { path: 'archive', element: <ArchiveRoute /> },
    { path: 'archive/transfers/:transferId', element: <NotFoundState /> },
    { path: 'admin/units', element: <AdminRoute capability="identity.manage" description="La administración de unidades estará disponible en el siguiente ciclo." title="Unidades" /> },
    { path: 'admin/access', element: <AdminRoute capability="identity.manage" description="Gestiona el acceso institucional con capacidades, no con etiquetas de rol." title="Usuarios y acceso" /> },
    { path: 'admin/expediente-types', element: <AdminRoute capability="expediente_type.manage_draft" description="Configura tipos de expediente y sus versiones publicables." title="Tipos de expediente" /> },
    { path: 'admin/classification', element: <AdminRoute capability="archive_transfer.prepare" description="Consulta la clasificación archivística institucional." title="Clasificación archivística" /> },
    { path: 'admin/institution', element: <AdminRoute capability="institution.configure" description="Consulta la configuración de la institución activa." title="Institución" /> },
    { path: '*', element: <NotFoundState /> },
  ],
}]);
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
