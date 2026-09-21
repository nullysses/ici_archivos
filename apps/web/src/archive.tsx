import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Alert, Box, Button, Chip, Collapse, Divider, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useState, type ReactElement } from 'react';
import { apiMutation, canInstitution, fetchArchiveQueue, fetchArchiveTransferWorkspace, type ArchiveQueue, type ArchiveTransferWorkspace, type TransferQueueItem } from './api.js';
import { useShellContext } from './App.js';
import { AuditTimeline, ConfirmAction, EmptyState, ErrorState, Folio, ForbiddenState, ImmutableIndicator, LifecycleBadge, LoadingState, NotFoundState } from './ux.js';

const categoryLabels: Record<string, string> = { READY: 'Por preparar', POR_APROBAR: 'Por aprobar', EN_PRESERVACION: 'En preservación', REQUIEREN_ATENCION: 'Requieren atención', COMPLETADOS: 'Completados', OTROS: 'Otros' };

function archivalPathLabel(path: readonly { readonly nodeType: string; readonly name: string }[]): string {
  return path.map((node) => node.name).join(' > ') || 'Sin clasificación archivística';
}

function interventionLabel(kind: string): string {
  return ({ USER_INPUT: 'Entrada requerida', RECONCILIATION: 'Reconciliación', PRESERVATION_INTERVENTION: 'Intervención de preservación', FAILURE: 'Error recuperable' } as Record<string, string>)[kind] ?? 'Requiere atención';
}

export function ArchivePage(): ReactElement {
  const context = useShellContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [category, setCategory] = useState('READY');
  const [prepareId, setPrepareId] = useState<string | null>(null);
  const queue = useQuery({ queryKey: ['archive', 'queue'], queryFn: fetchArchiveQueue, enabled: context.session !== null && context.session !== undefined && canInstitution(context.session, 'records.read'), refetchInterval: (query) => { const active = query.state.data?.transfers.some((item) => item.transferStatus === 'APPROVED' || item.transferStatus === 'SUBMITTED' || item.transferStatus === 'PRESERVING') ?? false; return active ? 15000 : false; } });
  const prepare = useMutation({ mutationFn: (expedienteId: string) => apiMutation<{ readonly id: string }>(`/expedientes/${expedienteId}/archive-transfers`, {}), onSuccess: (transfer) => { void queryClient.invalidateQueries({ queryKey: ['archive'] }); setPrepareId(null); void navigate(`/archive/transfers/${transfer.id}`); } });
  if (context.session === null || context.session === undefined || !canInstitution(context.session, 'records.read')) return <ForbiddenState />;
  if (queue.isPending) return <LoadingState label="Cargando bandeja archivística" />;
  if (queue.error) return <ErrorState message={queue.error.message} onRetry={() => { void queue.refetch(); }} />;
  const data = queue.data;
  const items = category === 'READY' ? [] : (data?.transfers ?? []).filter((item) => item.category === category);
  return <Stack spacing={3}>
    <Box><Typography component="h2" variant="h3">Archivo</Typography><Typography color="text.secondary">Bandeja de preparación, aprobación y preservación archivística.</Typography></Box>
    <Tabs aria-label="Bandeja archivística" onChange={(_, value: string) => setCategory(value)} scrollButtons="auto" value={category} variant="scrollable">
      <Tab label={`Por preparar (${data?.readyForPreparation.length ?? 0})`} value="READY" />
      {(['POR_APROBAR', 'EN_PRESERVACION', 'REQUIEREN_ATENCION', 'COMPLETADOS'] as const).map((value) => <Tab key={value} label={categoryLabels[value]} value={value} />)}
    </Tabs>
    {category === 'READY' ? <ReadyQueue canPrepare={canInstitution(context.session, 'archive_transfer.prepare')} items={data?.readyForPreparation ?? []} onPrepare={setPrepareId} /> : <TransferQueue items={items} />}
    {prepareId !== null ? <ConfirmAction confirmDisabled={prepare.isPending} consequence="Se creará un borrador y se congelará la instantánea de preparación del expediente. Todavía no se aprobará la preservación." onCancel={() => setPrepareId(null)} onConfirm={() => prepare.mutate(prepareId)} open title="Preparar transferencia archivística" /> : null}
    {prepare.error ? <Alert severity="error">No se pudo preparar la transferencia: {prepare.error.message}</Alert> : null}
  </Stack>;
}

function ReadyQueue({ canPrepare, items, onPrepare }: { readonly canPrepare: boolean; readonly items: ArchiveQueue['readyForPreparation']; readonly onPrepare: (id: string) => void }): ReactElement {
  if (items.length === 0) return <EmptyState title="No hay expedientes listos para preparar" description="Los expedientes cerrados con clasificación archivística aparecerán aquí." />;
  return <Stack spacing={1.5}>{items.map((item) => <Box key={item.expedienteId} sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 2, p: 2.5 }}><Stack alignItems={{ md: 'center', xs: 'flex-start' }} direction={{ md: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}><Box><Folio value={item.expedienteFolio} /><Typography color="text.secondary" variant="body2">{archivalPathLabel(item.archivalPath)}</Typography></Box>{canPrepare ? <Button onClick={() => onPrepare(item.expedienteId)} startIcon={<ArchiveOutlinedIcon />} variant="contained">Preparar transferencia</Button> : <Typography color="text.secondary">No tienes permiso para preparar transferencias.</Typography>}</Stack></Box>)}</Stack>;
}

function TransferQueue({ items }: { readonly items: readonly TransferQueueItem[] }): ReactElement {
  if (items.length === 0) return <EmptyState title="No hay transferencias en esta bandeja" description="Cuando existan transferencias con este estado aparecerán aquí." />;
  return <Stack spacing={1.5}>{items.map((item) => <Box key={item.transferId} sx={{ bgcolor: 'background.paper', border: 1, borderColor: item.intervention === null ? 'divider' : 'warning.main', borderRadius: 2, p: 2.5 }}><Stack alignItems={{ md: 'center', xs: 'flex-start' }} direction={{ md: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}><Box><Button component={Link} sx={{ px: 0 }} to={`/archive/transfers/${item.transferId}`}><Folio value={item.expedienteFolio} /></Button><Stack alignItems="center" direction="row" spacing={2}><LifecycleBadge status={item.transferStatus} />{item.intervention ? <Chip color="warning" label={interventionLabel(item.intervention.kind)} size="small" /> : null}</Stack><Typography color="text.secondary" variant="body2">{archivalPathLabel(item.archivalPath)}</Typography></Box><Button component={Link} to={`/archive/transfers/${item.transferId}`}>Abrir transferencia</Button></Stack></Box>)}</Stack>;
}

export function ArchiveTransferDetailPage(): ReactElement {
  const { transferId = '' } = useParams();
  const context = useShellContext();
  const queryClient = useQueryClient();
  const [approvalOpen, setApprovalOpen] = useState(false);
  const workspace = useQuery({ queryKey: ['archive', 'transfer', transferId], queryFn: () => fetchArchiveTransferWorkspace(transferId), enabled: transferId !== '' && context.session !== null && context.session !== undefined && canInstitution(context.session, 'records.read'), refetchInterval: (query) => { const status = query.state.data?.transfer.status; return status === 'APPROVED' || status === 'SUBMITTED' || status === 'PRESERVING' ? 5000 : false; } });
  const approve = useMutation({ mutationFn: () => apiMutation(`/archive-transfers/${transferId}/approve`, {}), onSuccess: () => { setApprovalOpen(false); void queryClient.invalidateQueries({ queryKey: ['archive'] }); } });
  const retry = useMutation({ mutationFn: () => apiMutation(`/archive-transfers/${transferId}/retry`, {}), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['archive'] }); } });
  if (context.session === null || context.session === undefined || !canInstitution(context.session, 'records.read')) return <ForbiddenState />;
  if (workspace.isPending) return <LoadingState label="Cargando transferencia archivística" />;
  if (workspace.error instanceof Error && 'status' in workspace.error && (workspace.error as { status?: number }).status === 404) return <NotFoundState />;
  if (workspace.error || workspace.data === undefined) return <ErrorState message={workspace.error?.message} onRetry={() => { void workspace.refetch(); }} />;
  const item = workspace.data;
  const canApprove = item.transfer.status === 'DRAFT' && canInstitution(context.session, 'archive_transfer.approve');
  const canRetry = item.transfer.status === 'FAILED' && item.intervention?.kind === 'FAILURE' && canInstitution(context.session, 'archive_transfer.retry');
  return <Stack spacing={3}>
    <Button component={Link} to="/archive" sx={{ alignSelf: 'flex-start' }}>Volver a Archivo</Button>
    <Stack alignItems={{ md: 'center', xs: 'flex-start' }} direction={{ md: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}><Box><Folio value={item.expediente.folio} /><Typography component="h2" variant="h3">Transferencia archivística</Typography></Box><LifecycleBadge status={item.transfer.status} /></Stack>
    {item.intervention ? <Alert severity={item.intervention.kind === 'FAILURE' ? 'error' : 'warning'} icon={<ErrorOutlineOutlinedIcon />}><Typography fontWeight={700}>{interventionLabel(item.intervention.kind)}</Typography><Typography>{item.intervention.message}</Typography></Alert> : null}
    <Stack direction={{ md: 'row', xs: 'column' }} spacing={1}>{canApprove ? <Button disabled={approve.isPending} onClick={() => setApprovalOpen(true)} variant="contained">Aprobar transferencia</Button> : null}{canRetry ? <Button disabled={retry.isPending} onClick={() => retry.mutate()} variant="outlined">Reintentar preservación</Button> : null}</Stack>
    <ProgressPanel item={item} />
    <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 2, p: 2.5 }}><Typography gutterBottom variant="h5">Manifest</Typography>{item.transfer.manifest.status === 'APPROVED' ? <ImmutableIndicator label="Manifest aprobado — inmutable" /> : <Chip label="Borrador" size="small" />}{item.transfer.manifest.sha256 ? <Typography sx={{ fontFamily: 'ui-monospace, monospace', mt: 1, wordBreak: 'break-all' }}>SHA-256: {item.transfer.manifest.sha256}</Typography> : null}<Typography color="text.secondary" sx={{ mt: 1 }}>Expediente: <Folio value={item.expediente.folio} /></Typography><Typography color="text.secondary">Clasificación: {archivalPathLabel(item.archivalPath)}</Typography><ManifestDocuments item={item} /></Box>
    <ReferencesPanel item={item} />
    <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 2, p: 2.5 }}><Typography gutterBottom variant="h5">Actividad</Typography><AuditTimeline entries={item.activity.map((event) => ({ id: event.id, label: transferActivityLabel(event.eventType), at: event.occurredAt, ...(event.actorUserId === null ? {} : { actor: event.actorUserId }) }))} /></Box>
    {approve.error ? <Alert severity="error">No se pudo aprobar: {approve.error.message}</Alert> : null}{retry.error ? <Alert severity="error">No se pudo reintentar: {retry.error.message}</Alert> : null}
    <ConfirmAction confirmDisabled={approve.isPending} consequence="Al aprobar esta transferencia, el manifest y su SHA-256 quedan congelados y se crea la intención durable de preservación." onCancel={() => setApprovalOpen(false)} onConfirm={() => approve.mutate()} open={approvalOpen} title="Aprobar transferencia archivística" />
  </Stack>;
}

function ManifestDocuments({ item }: { readonly item: ArchiveTransferWorkspace }): ReactElement { const [open, setOpen] = useState(false); return <Box sx={{ mt: 2 }}><Button endIcon={<ExpandMoreIcon />} onClick={() => setOpen(!open)}>{open ? 'Ocultar documentos' : `Ver documentos incluidos (${item.transfer.manifest.documents.length})`}</Button><Collapse in={open}><Stack divider={<Divider />} spacing={1} sx={{ mt: 1 }}>{item.transfer.manifest.documents.map((document) => <Box key={document.versionId} sx={{ py: 1 }}><Typography fontWeight={650}>{document.filename} · v{document.versionNumber}</Typography><Typography color="text.secondary" variant="body2">{document.sizeBytes} bytes · {document.mimeType} · SHA-256 {document.sha256}</Typography><Chip color="success" label="Limpio" size="small" sx={{ mt: 0.5 }} /></Box>)}</Stack></Collapse></Box>; }

export function ProgressPanel({ item }: { readonly item: ArchiveTransferWorkspace }): ReactElement { const stages = [{ label: 'Manifest aprobado', done: item.transfer.status !== 'DRAFT', active: item.transfer.status === 'DRAFT' }, { label: 'Jerarquía y File AtoM verificados', done: item.atom.parent !== null && item.atom.file !== null, active: item.atom.parent !== null && item.atom.file === null }, { label: 'Paquete preparado', done: item.staging?.status === 'STAGED', active: item.staging?.status === 'IN_PROGRESS' }, { label: 'Transferencia Archivematica', done: item.evidence?.lastRemoteStatus === 'COMPLETE', active: item.evidence?.lastRemoteStatus === 'PROCESSING' || item.evidence?.submissionStatus === 'SUBMITTED' }, { label: 'Ingesta Archivematica', done: item.evidence?.lastIngestStatus === 'COMPLETE', active: item.evidence?.lastIngestStatus === 'PROCESSING' }, { label: 'AIP almacenado', done: item.evidence?.aipUuid !== null && item.evidence?.aipUuid !== undefined, active: item.evidence?.lastIngestStatus === 'COMPLETE' && item.evidence?.aipUuid === null }, { label: 'DIP identificado', done: item.evidence?.dipUuid !== null && item.evidence?.dipUuid !== undefined, active: false }, { label: 'Integración AtoM verificada', done: item.transfer.status === 'COMPLETED', active: false }]; return <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 2, p: 2.5 }}><Typography gutterBottom variant="h5">Progreso de preservación</Typography><Stack spacing={1}>{stages.map((stage) => <Stack alignItems="center" direction="row" key={stage.label} spacing={1.5}>{stage.done ? <CheckCircleOutlineOutlinedIcon color="success" fontSize="small" /> : <Box aria-hidden="true" sx={{ bgcolor: stage.active ? 'warning.main' : 'action.disabled', borderRadius: '50%', height: 10, width: 10 }} />}<Typography color={stage.active ? 'text.primary' : 'text.secondary'} fontWeight={stage.active ? 700 : 400}>{stage.label}{stage.active ? ' · En curso' : ''}</Typography></Stack>)}</Stack>{item.intervention?.kind === 'PRESERVATION_INTERVENTION' ? <Alert severity="warning" sx={{ mt: 2 }}>Requiere verificación humana: el DIP fue identificado, pero la API pública no prueba automáticamente los Items bajo el File esperado en AtoM.</Alert> : null}</Box>; }

function ReferencesPanel({ item }: { readonly item: ArchiveTransferWorkspace }): ReactElement { const [open, setOpen] = useState(false); const atomReference = item.atom.file ?? item.atom.parent; return <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 2, p: 2.5 }}><Typography gutterBottom variant="h5">Referencias externas</Typography>{atomReference === null ? <Typography color="text.secondary">La jerarquía AtoM aún no está sincronizada.</Typography> : <Typography>AtoM {item.atom.file === null ? 'parent' : 'File'}: <Box component="span" sx={{ fontFamily: 'ui-monospace, monospace' }}>{atomReference.slug}</Box></Typography>}{item.evidence?.archivematicaTransferUuid ? <Typography sx={{ mt: 1 }}>Transferencia Archivematica: {item.evidence.archivematicaTransferUuid}</Typography> : null}{item.evidence?.sipUuid ? <Typography>SIP: {item.evidence.sipUuid}</Typography> : null}{item.evidence?.aipUuid ? <Typography>AIP almacenado: {item.evidence.aipUuid}</Typography> : null}{item.evidence?.dipUuid ? <Typography>DIP identificado: {item.evidence.dipUuid}</Typography> : null}<Button onClick={() => setOpen(!open)} sx={{ mt: 1 }}>{open ? 'Ocultar detalles técnicos' : 'Detalles técnicos'}</Button><Collapse in={open}><Stack spacing={0.5} sx={{ mt: 1 }}><Typography color="text.secondary" sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{item.staging ? `Staging: ${item.staging.locationUuid}/${item.staging.relativePath}` : 'Sin staging persistido'}</Typography>{item.job ? <Typography color="text.secondary" sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>Job: {item.job.status} · intentos {item.job.attemptCount}{item.job.lastError ? ` · ${item.job.lastError}` : ''}</Typography> : null}</Stack></Collapse></Box>; }

function transferActivityLabel(eventType: string): string { const labels: Record<string, string> = { 'archive_transfer.created': 'Transferencia preparada', 'transfer_manifest.created': 'Manifest creado', 'transfer_manifest.approved': 'Manifest aprobado', 'archive_transfer.approved': 'Transferencia aprobada', 'archive_transfer.submitted': 'Preservación enviada', 'archive_transfer.preserving': 'Preservación iniciada', 'archive_transfer.failed': 'Preservación fallida', 'archive_transfer.retried': 'Reintento solicitado', 'archive_transfer.completed': 'Transferencia completada' }; return labels[eventType] ?? eventType; }
