import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { applyFoundationMigrations, createDatabase, loadArchivalClassificationPath, type Database } from './index.js';

const institutionId = '57000000-0000-4000-8000-000000000001';
const foreignInstitutionId = '57000000-0000-4000-8000-000000000002';
const fondsId = '57000000-0000-4000-8000-000000000003';
const sectionId = '57000000-0000-4000-8000-000000000004';
const seriesId = '57000000-0000-4000-8000-000000000005';
const subseriesId = '57000000-0000-4000-8000-000000000006';
const invalidSectionId = '57000000-0000-4000-8000-000000000007';
const foreignSeriesId = '57000000-0000-4000-8000-000000000008';
const cycleAId = '57000000-0000-4000-8000-000000000009';
const cycleBId = '57000000-0000-4000-8000-00000000000a';

describe('archival classification path loader', () => {
  let database: Database | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.6-alpine3.22').start();
    database = createDatabase(container.getConnectionUri());
    await sql`CREATE ROLE ici_app NOLOGIN NOSUPERUSER NOBYPASSRLS`.execute(database);
    await applyFoundationMigrations(database);
    await database.insertInto('institutions').values([
      { id: institutionId, code: 'HIER-A', name: 'Hierarchy A', status: 'ACTIVE' },
      { id: foreignInstitutionId, code: 'HIER-B', name: 'Hierarchy B', status: 'ACTIVE' },
    ]).execute();
    await database.insertInto('archival_classification_nodes').values([
      { id: fondsId, institution_id: institutionId, parent_id: null, node_type: 'FONDS', code: 'F', name: 'Fonds', metadata: {} },
      { id: sectionId, institution_id: institutionId, parent_id: fondsId, node_type: 'SECTION', code: 'S', name: 'Section', metadata: {} },
      { id: seriesId, institution_id: institutionId, parent_id: sectionId, node_type: 'SERIES', code: 'SR', name: 'Series', metadata: {} },
      { id: subseriesId, institution_id: institutionId, parent_id: seriesId, node_type: 'SUBSERIES', code: 'SS', name: 'Subseries', metadata: {} },
      { id: invalidSectionId, institution_id: institutionId, parent_id: null, node_type: 'SECTION', code: 'INVALID', name: 'Invalid', metadata: {} },
      { id: foreignSeriesId, institution_id: foreignInstitutionId, parent_id: null, node_type: 'SERIES', code: 'FOREIGN', name: 'Foreign', metadata: {} },
      { id: cycleAId, institution_id: institutionId, parent_id: fondsId, node_type: 'SECTION', code: 'CYCLE-A', name: 'Cycle A', metadata: {} },
      { id: cycleBId, institution_id: institutionId, parent_id: cycleAId, node_type: 'SERIES', code: 'CYCLE-B', name: 'Cycle B', metadata: {} },
    ]).execute();
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
    await container?.stop();
  });

  function db(): Database {
    if (database === undefined) throw new Error('Database unavailable');
    return database;
  }

  it('returns a valid path root-first', async () => {
    const path = await loadArchivalClassificationPath(db(), { institutionId, targetNodeId: subseriesId });
    expect(path.map((node) => node.nodeType)).toEqual(['FONDS', 'SECTION', 'SERIES', 'SUBSERIES']);
    expect(path.map((node) => node.id)).toEqual([fondsId, sectionId, seriesId, subseriesId]);
  });

  it('supports a SERIES target without a SUBSERIES', async () => {
    const path = await loadArchivalClassificationPath(db(), { institutionId, targetNodeId: seriesId });
    expect(path.map((node) => node.nodeType)).toEqual(['FONDS', 'SECTION', 'SERIES']);
  });

  it('rejects malformed, foreign, and cyclic paths', async () => {
    await expect(loadArchivalClassificationPath(db(), { institutionId, targetNodeId: invalidSectionId })).rejects.toMatchObject({ code: 'ARCHIVAL_HIERARCHY_INVALID' });
    await expect(loadArchivalClassificationPath(db(), { institutionId, targetNodeId: foreignSeriesId })).rejects.toMatchObject({ code: 'ARCHIVAL_NODE_NOT_FOUND' });
    await db().updateTable('archival_classification_nodes').set({ parent_id: cycleBId }).where('institution_id', '=', institutionId).where('id', '=', cycleAId).execute();
    await expect(loadArchivalClassificationPath(db(), { institutionId, targetNodeId: cycleBId })).rejects.toMatchObject({ code: 'ARCHIVAL_HIERARCHY_INVALID' });
  });
});
