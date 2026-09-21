import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import SearchOffOutlinedIcon from '@mui/icons-material/SearchOffOutlined';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Skeleton, Stack, Typography } from '@mui/material';
import { useState, type ReactElement, type ReactNode } from 'react';

export function Folio({ value }: { readonly value: string }): ReactElement {
  return <Typography component="span" sx={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontWeight: 700, letterSpacing: 0.3 }}>{value}</Typography>;
}

const statusLabels: Record<string, string> = {
  RECEIVED: 'Recibido', ASSIGNED: 'Asignado', IN_PROGRESS: 'En proceso', RESOLVED: 'Resuelto', CLOSED: 'Cerrado', VOIDED: 'Anulado',
  OPEN: 'Abierto', TRANSFER_PENDING: 'Transferencia pendiente', TRANSFERRED: 'Transferido',
  DRAFT: 'Borrador', APPROVED: 'Aprobado', SUBMITTED: 'Enviado', PRESERVING: 'En preservación', COMPLETED: 'Completado', FAILED: 'Fallido', CANCELLED: 'Cancelado',
};

const statusColors: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  RECEIVED: 'info', ASSIGNED: 'info', IN_PROGRESS: 'warning', RESOLVED: 'success', CLOSED: 'default', VOIDED: 'error',
  OPEN: 'success', TRANSFER_PENDING: 'warning', TRANSFERRED: 'success', DRAFT: 'default', APPROVED: 'info', SUBMITTED: 'info', PRESERVING: 'warning', COMPLETED: 'success', FAILED: 'error', CANCELLED: 'default',
};

export function LifecycleBadge({ status }: { readonly status: string }): ReactElement {
  return <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}><Box aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: statusColors[status] === 'success' ? 'success.main' : statusColors[status] === 'error' ? 'error.main' : statusColors[status] === 'warning' ? 'warning.main' : statusColors[status] === 'info' ? 'info.main' : 'text.disabled' }} /><Typography component="span" variant="body2">{statusLabels[status] ?? status}</Typography></Box>;
}

export interface AuditTimelineEntry { readonly id: string; readonly label: string; readonly at: string; readonly actor?: string; readonly unit?: string; }

export function AuditTimeline({ entries }: { readonly entries: readonly AuditTimelineEntry[] }): ReactElement {
  if (entries.length === 0) return <EmptyState title="Sin actividad registrada" />;
  return <Stack component="ol" spacing={2} sx={{ listStyle: 'none', m: 0, p: 0 }}>{entries.map((entry) => <Box component="li" key={entry.id} sx={{ borderLeft: 2, borderColor: 'divider', pl: 2 }}><Typography fontWeight={650}>{entry.label}</Typography><Typography color="text.secondary" variant="body2">{new Date(entry.at).toLocaleString('es-MX')}{entry.actor === undefined ? '' : ` · ${entry.actor}`}{entry.unit === undefined ? '' : ` · ${entry.unit}`}</Typography></Box>)}</Stack>;
}

export function ActorUnit({ actor, unit }: { readonly actor?: string; readonly unit?: string }): ReactElement {
  return <Typography color="text.secondary" variant="body2">{actor ?? 'Actor del sistema'}{unit === undefined ? '' : ` · ${unit}`}</Typography>;
}

export function ImmutableIndicator({ label = 'Registro inmutable' }: { readonly label?: string }): ReactElement {
  return <Chip icon={<LockOutlinedIcon />} label={label} size="small" variant="outlined" />;
}

export function ExternalReference({ system, reference, href }: { readonly system: string; readonly reference: string; readonly href?: string }): ReactElement {
  const content = <Stack alignItems="center" direction="row" spacing={0.5}><Typography component="span" variant="body2">{system}: {reference}</Typography>{href === undefined ? null : <OpenInNewOutlinedIcon fontSize="inherit" />}</Stack>;
  return href === undefined ? content : <Box component="a" href={href} rel="noreferrer" target="_blank" sx={{ color: 'primary.main' }}>{content}</Box>;
}

export function LoadingState({ label = 'Cargando información' }: { readonly label?: string }): ReactElement {
  return <Stack aria-label={label} role="status" spacing={1.5}><Skeleton height={30} variant="text" width="45%" /><Skeleton height={22} variant="text" width="80%" /><Skeleton height={22} variant="text" width="65%" /></Stack>;
}

export function EmptyState({ title, description, filtered = false }: { readonly title: string; readonly description?: string; readonly filtered?: boolean }): ReactElement {
  return <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ py: 8, textAlign: 'center' }}><SearchOffOutlinedIcon color="disabled" fontSize="large" /><Typography component="h3" variant="h6">{title}</Typography><Typography color="text.secondary" maxWidth={520}>{description ?? (filtered ? 'Prueba con otros filtros o limpia la búsqueda.' : 'Cuando haya información disponible aparecerá aquí.')}</Typography></Stack>;
}

export function ErrorState({ title = 'No se pudo cargar la información', message, onRetry }: { readonly title?: string; readonly message?: string; readonly onRetry?: () => void }): ReactElement {
  return <Alert action={onRetry === undefined ? undefined : <Button color="inherit" onClick={onRetry}>Reintentar</Button>} icon={<ErrorOutlineOutlinedIcon />} severity="error"> <Typography component="span" fontWeight={700}>{title}</Typography>{message === undefined ? null : <Typography component="span" display="block">{message}</Typography>}</Alert>;
}

export function ForbiddenState(): ReactElement {
  return <StatePanel icon={<LockOutlinedIcon color="warning" fontSize="large" />} title="No tienes permisos para ver esta sección" description="Tu sesión no cuenta con la capacidad necesaria. Si necesitas acceso, solicita apoyo a la administración de tu institución." />;
}

export function NotFoundState(): ReactElement {
  return <StatePanel icon={<SearchOffOutlinedIcon color="disabled" fontSize="large" />} title="Página no encontrada" description="La dirección solicitada no existe o ya no está disponible." />;
}

export function OfflineState(): ReactElement {
  return <StatePanel icon={<InfoOutlinedIcon color="warning" fontSize="large" />} title="Servicio temporalmente no disponible" description="No fue posible comunicarse con la API. Intenta nuevamente en unos momentos." />;
}

function StatePanel({ icon, title, description }: { readonly icon: ReactNode; readonly title: string; readonly description: string }): ReactElement {
  return <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ minHeight: 280, textAlign: 'center' }}>{icon}<Typography component="h2" variant="h5">{title}</Typography><Typography color="text.secondary" maxWidth={520}>{description}</Typography></Stack>;
}

export function ConfirmAction({ open, title, consequence, confirmLabel = 'Confirmar', confirmDisabled = false, onCancel, onConfirm }: { readonly open: boolean; readonly title: string; readonly consequence: string; readonly confirmLabel?: string; readonly confirmDisabled?: boolean; readonly onCancel: () => void; readonly onConfirm: () => void }): ReactElement {
  return <Dialog aria-labelledby="confirmation-title" fullWidth maxWidth="sm" onClose={onCancel} open={open}><DialogTitle id="confirmation-title">{title}</DialogTitle><DialogContent><Typography>{consequence}</Typography></DialogContent><DialogActions><Button disabled={confirmDisabled} onClick={onCancel}>Cancelar</Button><Button color="error" disabled={confirmDisabled} onClick={onConfirm} variant="contained">{confirmDisabled ? 'Procesando…' : confirmLabel}</Button></DialogActions></Dialog>;
}

export function useConfirmAction(): { readonly open: boolean; readonly ask: () => void; readonly cancel: () => void; readonly confirm: (action: () => void) => void } {
  const [open, setOpen] = useState(false);
  return { open, ask: () => setOpen(true), cancel: () => setOpen(false), confirm: (action) => { setOpen(false); action(); } };
}
