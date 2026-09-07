import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Alert, AppBar, Box, Card, CardContent, Chip, Container, Stack, Toolbar, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@ici/contracts';

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  const body = (await response.json()) as HealthResponse;
  if (!response.ok && response.status !== 503) throw new Error('No se pudo consultar la API');
  return body;
}

export function App() {
  const health = useQuery({ queryKey: ['system-health'], queryFn: fetchHealth, retry: false });
  const ready = health.data?.status === 'ok';

  return (
    <Box sx={{ minHeight: '100vh' }}>
      <AppBar elevation={0} position="static">
        <Toolbar>
          <ArchiveOutlinedIcon sx={{ mr: 1.5 }} />
          <Typography component="h1" variant="h6">ICI Archivos</Typography>
        </Toolbar>
      </AppBar>
      <Container maxWidth="md" sx={{ py: 8 }}>
        <Stack spacing={3}>
          <Box>
            <Typography component="h2" gutterBottom variant="h3">Base operativa lista</Typography>
            <Typography color="text.secondary" variant="h6">
              Gestión documental, transferencia archivística y preservación digital.
            </Typography>
          </Box>
          <Card variant="outlined">
            <CardContent>
              <Stack alignItems="center" direction="row" justifyContent="space-between" spacing={2}>
                <Box>
                  <Typography gutterBottom variant="overline">Estado del sistema</Typography>
                  <Typography variant="h5">API y PostgreSQL</Typography>
                </Box>
                <Chip
                  color={ready ? 'success' : 'warning'}
                  icon={ready ? <CheckCircleOutlineIcon /> : <ErrorOutlineIcon />}
                  label={health.isPending ? 'Consultando' : ready ? 'Disponible' : 'Requiere atención'}
                />
              </Stack>
              {health.isError ? <Alert severity="error" sx={{ mt: 3 }}>{health.error.message}</Alert> : null}
              {health.data?.status === 'degraded' ? (
                <Alert severity="warning" sx={{ mt: 3 }}>La API está activa, pero PostgreSQL no está disponible.</Alert>
              ) : null}
            </CardContent>
          </Card>
        </Stack>
      </Container>
    </Box>
  );
}

