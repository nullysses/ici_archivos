import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import MenuIcon from '@mui/icons-material/Menu';
import PeopleAltOutlinedIcon from '@mui/icons-material/PeopleAltOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { Alert, AppBar, Box, Breadcrumbs, Button, Chip, Container, Divider, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Stack, Toolbar, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useRouteError } from 'react-router';
import { useState, type ReactElement } from 'react';
import { canAnywhere, canInstitution, fetchHealth, fetchSession, type Capability, type HealthResponse, type Session } from './api.js';
import { EmptyState, ErrorState, ForbiddenState, LifecycleBadge, LoadingState, NotFoundState, OfflineState } from './ux.js';

interface NavigationItem { readonly label: string; readonly path: string; readonly icon: typeof HomeOutlinedIcon; readonly capability?: Capability; readonly capabilityScope?: 'institution' | 'any'; }
interface NavigationGroup { readonly label: string; readonly items: readonly NavigationItem[]; }

const primaryNavigation: readonly NavigationGroup[] = [{ label: 'Trabajo', items: [{ label: 'Inicio', path: '/work', icon: HomeOutlinedIcon }, { label: 'Asuntos', path: '/matters', icon: AssignmentOutlinedIcon, capability: 'records.read', capabilityScope: 'any' }, { label: 'Expedientes', path: '/expedientes', icon: FolderOutlinedIcon, capability: 'records.read' }, { label: 'Archivo', path: '/archive', icon: ArchiveOutlinedIcon, capability: 'records.read' }] }];
const administrationNavigation: readonly NavigationItem[] = [
  { label: 'Unidades', path: '/admin/units', icon: BusinessOutlinedIcon, capability: 'identity.manage' },
  { label: 'Usuarios y acceso', path: '/admin/access', icon: PeopleAltOutlinedIcon, capability: 'identity.manage' },
  { label: 'Tipos de expediente', path: '/admin/expediente-types', icon: Inventory2OutlinedIcon, capability: 'expediente_type.manage_draft' },
  { label: 'Clasificación archivística', path: '/admin/classification', icon: FolderOutlinedIcon, capability: 'archive_transfer.prepare' },
  { label: 'Institución', path: '/admin/institution', icon: SettingsOutlinedIcon, capability: 'institution.configure' },
];

export function App(): ReactElement {
  const session = useQuery({ queryKey: ['session'], queryFn: fetchSession, retry: false });
  const health = useQuery({ queryKey: ['system-health'], queryFn: fetchHealth, retry: false });
  return <AppShell session={session.data} sessionLoading={session.isPending} sessionError={session.error} health={health.data} healthLoading={health.isPending} healthError={health.error} />;
}

function AppShell({ session, sessionLoading, sessionError, health, healthLoading, healthError }: { readonly session: Session | null | undefined; readonly sessionLoading: boolean; readonly sessionError: Error | null; readonly health: HealthResponse | undefined; readonly healthLoading: boolean; readonly healthError: Error | null }): ReactElement {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('md'));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const nav = useNavigate();
  const adminItems = administrationNavigation.filter((item) => session !== null && session !== undefined && canInstitution(session, item.capability!));
  const drawer = <NavigationDrawer session={session} currentPath={location.pathname} adminItems={adminItems} onNavigate={() => setDrawerOpen(false)} />;
  return <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
    <AppBar color="inherit" elevation={0} position="fixed" sx={{ borderBottom: 1, borderColor: 'divider', zIndex: (muiTheme) => muiTheme.zIndex.drawer + 1 }}>
      <Toolbar sx={{ gap: 1.5 }}>
        {compact ? <IconButton aria-label="Abrir navegación" onClick={() => setDrawerOpen(true)}><MenuIcon /></IconButton> : null}
        <ArchiveOutlinedIcon color="primary" />
        <Typography component="h1" fontWeight={800} sx={{ flexGrow: 1 }} variant="h6">ICI Archivos</Typography>
        <Stack alignItems="flex-end" spacing={0} sx={{ display: { xs: 'none', sm: 'flex' } }}><Typography variant="body2">{session === null ? 'Sesión no iniciada' : sessionLoading ? 'Cargando sesión…' : 'Usuario autenticado'}</Typography><Typography color="text.secondary" variant="caption">{session === null ? 'Acceso institucional' : 'Institución activa'}</Typography></Stack>
        <Tooltip title="Cerrar sesión (disponible cuando OIDC esté conectado)"><span><Button disabled={!session} onClick={() => nav('/')} size="small">Cuenta</Button></span></Tooltip>
      </Toolbar>
    </AppBar>
    {!compact ? <Drawer open variant="permanent" sx={{ width: 264, flexShrink: 0, '& .MuiDrawer-paper': { boxSizing: 'border-box', width: 264, pt: 8 } }}>{drawer}</Drawer> : <Drawer onClose={() => setDrawerOpen(false)} open={drawerOpen}>{drawer}</Drawer>}
    <Box component="main" sx={{ flexGrow: 1, minWidth: 0, pt: 10 }}><Container maxWidth="xl" sx={{ pb: 6 }}>
      <Breadcrumbs aria-label="Ruta de navegación" separator={<ChevronRightIcon fontSize="small" />} sx={{ mb: 2 }}><Typography color="text.secondary" variant="body2">ICI Archivos</Typography><Typography color="text.primary" variant="body2">{breadcrumbFor(location.pathname)}</Typography></Breadcrumbs>
      {sessionError !== null ? <Alert severity="warning" sx={{ mb: 2 }}>No fue posible consultar la sesión. Algunas secciones permanecerán ocultas.</Alert> : null}
      {healthError !== null ? <Alert severity="warning" sx={{ mb: 2 }}>La API no está disponible en este momento.</Alert> : null}
      <Outlet context={{ session, sessionLoading, health, healthLoading, healthError }} />
    </Container></Box>
  </Box>;
}

function NavigationDrawer({ session, currentPath, adminItems, onNavigate }: { readonly session: Session | null | undefined; readonly currentPath: string; readonly adminItems: readonly NavigationItem[]; readonly onNavigate: () => void }): ReactElement {
  return <Box sx={{ px: 1.5, py: 2 }}><Typography color="text.secondary" sx={{ px: 1.5, mb: 1 }} variant="overline">Módulos</Typography>{primaryNavigation.map((group) => <List aria-label={group.label} key={group.label} sx={{ mb: 1 }}>{group.items.filter((item) => item.capability === undefined || (session !== null && session !== undefined && (item.capabilityScope === 'any' ? canAnywhere(session, item.capability) : canInstitution(session, item.capability)))).map((item) => <NavigationLink item={item} currentPath={currentPath} key={item.path} onNavigate={onNavigate} />)}</List>)}{adminItems.length > 0 ? <><Divider sx={{ my: 1 }} /><Typography color="text.secondary" sx={{ px: 1.5, mb: 1 }} variant="overline">Administración</Typography><List aria-label="Administración">{adminItems.map((item) => <NavigationLink item={item} currentPath={currentPath} key={item.path} onNavigate={onNavigate} />)}</List></> : null}<Box sx={{ px: 1.5, pt: 3 }}><Chip label={session === null ? 'Modo público' : 'Contexto institucional'} size="small" variant="outlined" /></Box></Box>;
}

function NavigationLink({ item, currentPath, onNavigate }: { readonly item: NavigationItem; readonly currentPath: string; readonly onNavigate: () => void }): ReactElement {
  const selected = currentPath === item.path || (item.path !== '/work' && currentPath.startsWith(`${item.path}/`));
  const Icon = item.icon;
  return <ListItemButton aria-current={selected ? 'page' : undefined} component={NavLink} onClick={onNavigate} selected={selected} to={item.path}><ListItemIcon><Icon fontSize="small" /></ListItemIcon><ListItemText primary={item.label} /></ListItemButton>;
}

function breadcrumbFor(path: string): string { if (path.startsWith('/matters')) return 'Asuntos'; if (path.startsWith('/expedientes')) return 'Expedientes'; if (path.startsWith('/archive')) return 'Archivo'; if (path.startsWith('/admin')) return 'Administración'; return 'Inicio / Mi trabajo'; }

export function WorkPage({ health, healthLoading, healthError, session }: { readonly health: HealthResponse | undefined; readonly healthLoading: boolean; readonly healthError: Error | null; readonly session: Session | null | undefined }): ReactElement {
  const ready = health?.status === 'ok';
  const canReadAnywhere = session !== null && session !== undefined && canAnywhere(session, 'records.read');
  const canReadInstitution = session !== null && session !== undefined && canInstitution(session, 'records.read');
  return <Stack spacing={3}><Box><Typography component="h2" gutterBottom variant="h3">Base operativa lista</Typography><Typography color="text.secondary" variant="h6">Gestión documental, transferencia archivística y preservación digital.</Typography></Box><Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { md: 'repeat(3, 1fr)', xs: '1fr' } }}>{canReadAnywhere ? <InfoCard title="Mi trabajo" value="Accede a tus asuntos y expedientes" href="/matters" /> : null}{canReadInstitution ? <InfoCard title="Archivo" value="Consulta el estado de las transferencias" href="/archive" /> : null}<InfoCard title="Contexto" value={session === null || session === undefined ? 'Inicia sesión para ver tu contexto' : 'Institución activa'} /></Box><Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 3 }}><Stack alignItems="center" direction="row" justifyContent="space-between" spacing={2}><Box><Typography gutterBottom variant="overline">Estado del sistema</Typography><Typography variant="h5">API y PostgreSQL</Typography></Box><Chip color={ready ? 'success' : 'warning'} label={healthLoading ? 'Consultando' : ready ? 'Disponible' : 'Requiere atención'} /></Stack>{healthError !== null && healthError !== undefined ? <ErrorState message={healthError.message} /> : null}{health?.status === 'degraded' ? <Alert severity="warning" sx={{ mt: 2 }}>La API está activa, pero PostgreSQL no está disponible.</Alert> : null}</Box></Stack>;
}

interface ShellContext { readonly session: Session | null | undefined; readonly sessionLoading: boolean; readonly health: HealthResponse | undefined; readonly healthLoading: boolean; readonly healthError: Error | null; }
const useShellContext = (): ShellContext => useOutletContext<ShellContext>();
export function WorkRoute(): ReactElement { const context = useShellContext(); return <WorkPage {...context} />; }
export function MattersRoute(): ReactElement { const context = useShellContext(); return <ProtectedPage capability="records.read" scope="any" session={context.session} sessionLoading={context.sessionLoading}><SectionPage description="Bandejas y seguimiento operativo de asuntos." title="Asuntos" /></ProtectedPage>; }
export function ExpedientesRoute(): ReactElement { const context = useShellContext(); return <ProtectedPage capability="records.read" session={context.session} sessionLoading={context.sessionLoading}><SectionPage description="Consulta de expedientes activos y cerrados." title="Expedientes" /></ProtectedPage>; }
export function ArchiveRoute(): ReactElement { const context = useShellContext(); return <ProtectedPage capability="records.read" session={context.session} sessionLoading={context.sessionLoading}><SectionPage description="Supervisa preparación, preservación y atención archivística." title="Archivo" /></ProtectedPage>; }
export function AdminRoute({ title, description, capability }: { readonly title: string; readonly description: string; readonly capability: Capability }): ReactElement { const context = useShellContext(); return <ProtectedPage capability={capability} session={context.session} sessionLoading={context.sessionLoading}><SectionPage description={description} title={title} /></ProtectedPage>; }

function InfoCard({ title, value, href }: { readonly title: string; readonly value: string; readonly href?: string }): ReactElement { const content = <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, height: '100%', p: 2.5, transition: 'border-color .15s', '&:hover': { borderColor: 'primary.main' } }}><Typography color="text.secondary" variant="overline">{title}</Typography><Typography sx={{ mt: 1 }} variant="body1">{value}</Typography></Box>; return href === undefined ? content : <Box component={Link} sx={{ color: 'inherit', textDecoration: 'none' }} to={href}>{content}</Box>; }

export function SectionPage({ title, description, status }: { readonly title: string; readonly description: string; readonly status?: string }): ReactElement { return <Stack spacing={3}><Box><Typography component="h2" variant="h3">{title}</Typography><Typography color="text.secondary" sx={{ mt: 1 }} variant="body1">{description}</Typography></Box>{status === undefined ? <EmptyState description="Esta superficie está lista para el siguiente ciclo de trabajo." title="Aún no hay elementos para mostrar" /> : <Stack alignItems="flex-start" direction="row" spacing={2}><LifecycleBadge status={status} /><Typography color="text.secondary">Estado de ejemplo de la presentación; los datos vendrán de la API del flujo correspondiente.</Typography></Stack>}</Stack>; }

export function ProtectedPage({ capability, scope = 'institution', children, session, sessionLoading }: { readonly capability: Capability; readonly scope?: 'institution' | 'any'; readonly children: ReactElement; readonly session: Session | null | undefined; readonly sessionLoading: boolean }): ReactElement { if (sessionLoading) return <LoadingState />; if (session === null || (scope === 'any' ? !canAnywhere(session, capability) : !canInstitution(session, capability))) return <ForbiddenState />; return children; }
export function RouteError(): ReactElement { const error = useRouteError(); if (error instanceof Response && error.status === 404) return <NotFoundState />; return <OfflineState />; }
