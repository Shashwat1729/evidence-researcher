import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exportMarkdown } from '../backend/src/routes.js';

const fixture = {
  task: { question: 'When was X founded?', mode: 'quick', stance: 'neutral' },
  stanceDisclosure: 'neutral',
  completedAt: '2026-01-01',
  report: {
    executiveSummary: 'X was founded in 1901.',
    established: ['Founded in 1901.'],
    findings: [{ heading: 'Date', body: 'Records show 1901.', cite: ['src_1', 'src_GHOST'] }],
    competing: [], contradictions: [],
    sourceQuality: 'One archive record.',
    independence: 'Single source.',
    books: [], primarySources: ['1901 charter (archive).'],
    uncertainty: ['Exact day unverified.'],
    gaps: ['Day-level record missing.'],
    methodology: 'Searched, fetched, verified.',
  },
  claims: [{ id: 'c1', text: 'X founded 1901', state: 'supported', confidenceWhy: 'archive record', supporting: [], contradicting: [] }],
  sources: [{ id: 'src_1', title: 'Archive charter', url: 'https://archives.example/x', domain: 'archives.example', tier: 1, sourceType: 'primary', accessibility: 'full', verified: true, passages: [] }],
};

describe('citation integrity in export', () => {
  it('links real sources and drops ghost ids upstream (orchestrator filters; export never invents URLs)', () => {
    const md = exportMarkdown(fixture);
    assert.ok(md.includes('https://archives.example/x'));
    assert.ok(!md.includes('src_GHOST'));
    assert.ok(!/Page number \d+/.test(md), 'no invented page numbers');
  });
  it('report exposes searched vs verified vs uncertain', () => {
    const md = exportMarkdown(fixture);
    assert.ok(md.includes('Uncertainty') && md.includes('Research gaps') && md.includes('Methodology'));
  });
});
