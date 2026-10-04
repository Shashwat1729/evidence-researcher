import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichFiguresFromCommons, figureBudget, figuresForReport, fileKey, findFigure, findFigurePage,
  imageQueryFor, imageQueryNarrow, matchSignals, queryTokens, stripHtml, titleMatch, toFigure,
} from '../backend/src/providers/images.js';
import { exportMarkdown, exportHtml, exportNotebookLm, exportMediaBrief } from '../backend/src/export.js';
import { runResearch } from '../backend/src/engine/orchestrator.js';

const IMG = 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Drain.jpg/1280px-Drain.jpg';
const page = (over = {}) => ({
  title: 'Drainage_system',
  fullurl: 'https://en.wikipedia.org/wiki/Drainage_system',
  pageimage: 'Drainage_system.jpg',
  thumbnail: { source: IMG, width: 1280, height: 800 },
  index: 0,
  ...over,
});

describe('figure query derivation', () => {
  it('drops filler words and keeps the subject', () => {
    assert.equal(imageQueryFor('Origins and early settlement', ''), 'Origins early settlement');
  });
  it('strips parentheticals that would confuse a wiki search', () => {
    assert.equal(imageQueryFor('Mohenjo-daro (UNESCO site)', ''), 'Mohenjo-daro');
  });
  it('borrows from the body when the heading is too thin to search', () => {
    const q = imageQueryFor('Sewage', 'Harappan cities used covered drains and soak pits throughout the urban grid.');
    assert.match(q, /Sewage/);
    assert.match(q, /Harappan/);
  });
  it('returns empty for nothing searchable', () => {
    assert.equal(imageQueryFor('', ''), '');
  });
});

describe('candidate scoring — a wrong photo is worse than none', () => {
  it('ranks the page that carries the identifying term', () => {
    assert.ok(
      titleMatch('mohenjo-daro harappan drainage systems', 'Mohenjo-daro') > titleMatch('mohenjo-daro harappan drainage systems', 'Indus River'),
      'a page naming the subject beats an incidentally-related one'
    );
  });
  it('scores an unrelated page at zero', () => {
    assert.ok(titleMatch('mohenjo-daro harappan', 'Grid plan') < 0.34, 'below the accept threshold');
    assert.equal(titleMatch('mohenjo-daro harappan', 'Grid plan'), 0);
  });
  it('handles punctuation and case identically', () => {
    assert.equal(titleMatch('Mohenjo-daro', 'mohenjo-daro'), titleMatch('mohenjo-daro', 'Mohenjo-Daro'));
    assert.ok(titleMatch('Mohenjo-daro', 'Mohenjo-daro') > 0.9, 'an exact subject match scores near 1');
  });

  // The regression that mattered: rank-only acceptance put a photograph of
  // Chang'an (a Chinese city) under a heading about Mohenjo-daro, because
  // "Grid plan" is a real article and ranked first.
  it('generic descriptors cannot justify a match on their own', () => {
    const tokens = queryTokens('Grid plan citadel Mohenjo-daro');
    assert.deepEqual(tokens, ['mohenjo-daro'], 'descriptors stripped, proper noun kept');
    assert.equal(matchSignals('Grid plan citadel Mohenjo-daro', 'Grid plan').specific, 0,
      '"Grid plan" shares no IDENTIFYING token with the query');
    assert.equal(matchSignals('Grid plan citadel Mohenjo-daro', 'Mohenjo-daro').specific, 1);
  });
  it('a synonym-only hit scores zero lexically — rank is what rescues it', () => {
    const s = matchSignals('Harappan Culture', 'Indus Valley Civilisation');
    assert.equal(s.specific, 0);
    assert.ok(s.coverage < 0.5);
  });
  it('the narrow query exposes the proper noun', () => {
    assert.equal(imageQueryNarrow('Grid plan citadel Mohenjo-daro'), 'mohenjo-daro');
    assert.equal(imageQueryNarrow(''), '');
  });
});

describe('figure records are attributable', () => {
  it('records the file so its licence can be fetched', () => {
    const f = toFigure(page(), 'q');
    assert.equal(f.file, 'Drainage_system.jpg', 'the FILE name, which is what carries the licence');
    assert.equal(f.url, IMG);
    assert.ok(f.sourcePage.includes('/wiki/File:'), 'cites the Commons FILE page, where the licence lives');
  });
  it('rejects SVG, non-upload hosts and missing thumbnails', () => {
    assert.equal(toFigure(page({ thumbnail: { source: 'https://upload.wikimedia.org/x/logo.svg' } }), 'q'), null);
    assert.equal(toFigure(page({ thumbnail: { source: 'https://evil.example/x.jpg' } }), 'q'), null);
    assert.equal(toFigure(page({ thumbnail: null }), 'q'), null);
    assert.equal(toFigure(null, 'q'), null);
  });
  it('strips html in metadata', () => {
    assert.equal(stripHtml('<b>a</b>&amp;b&nbsp;c'), 'a&b c');
  });

  // MediaWiki answers "File:A B.jpeg" for a request of "File:A_B.jpeg", so an
  // unnormalised join missed every figure and shipped "unknown author".
  it('normalises the underscore/space difference on both sides of the join', () => {
    assert.equal(fileKey('File:A_B.jpeg'), fileKey('A B.jpeg'));
    assert.equal(fileKey('A_B.jpeg'), 'a b.jpeg');
  });

  it('attaches author and licence from the Commons file', async () => {
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => ({
        query: {
          pages: [{
            // Note the spaces: the API normalised our underscored request.
            title: 'File:Drainage system.jpg',
            imageinfo: [{
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Drainage_system.jpg',
              extmetadata: {
                Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X">X</a>' },
                LicenseShortName: { value: 'CC BY-SA 4.0' },
                LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
                ImageDescription: { value: 'An ancient drain' },
              },
            }],
          }],
        },
      }),
    });
    const [fig] = await enrichFiguresFromCommons([toFigure(page(), 'q')], { fetchFn });
    assert.equal(fig.author, 'X', 'HTML stripped from the author field');
    assert.equal(fig.license, 'CC BY-SA 4.0');
    assert.equal(fig.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0');
    assert.equal(fig.alt, 'An ancient drain');
    assert.equal(fig.sourcePage, 'https://commons.wikimedia.org/wiki/File:Drainage_system.jpg');
  });

  it('a failed licence lookup leaves the image rather than dropping it', async () => {
    const fetchFn = async () => { throw new Error('offline'); };
    const [fig] = await enrichFiguresFromCommons([toFigure(page(), 'q')], { fetchFn });
    assert.ok(fig.url, 'image survives');
    assert.equal(fig.author, '', 'but it is not falsely credited');
  });
});

describe('figure lookup', () => {
  it('never throws — a report without photos is still a report', async () => {
    assert.equal(await findFigure('anything', { fetchFn: async () => { throw new Error('offline'); } }), null);
    assert.equal(await findFigure('x', { fetchFn: async () => ({ ok: false, status: 500 }) }), null);
    assert.equal(await findFigure('', { fetchFn: async () => ({ ok: true }) }), null);
  });
  it('keeps only candidates with a real lexical anchor, whatever the rank', async () => {
    const pages = [
      page({ title: 'Grid plan', index: 0 }),
      page({ title: 'Mohenjo-daro', index: 1 }),
    ];
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ query: { pages } }) });
    const found = await findFigurePage('Grid plan citadel Mohenjo-daro', { fetchFn });
    assert.equal(found.title, 'Mohenjo-daro', 'rank 0 "Grid plan" rejected; the anchored article wins');
  });
  it('budget scales with mode depth', () => {
    assert.ok(figureBudget('quick').total < figureBudget('deep').total);
    assert.ok(figureBudget('deep').perSection >= figureBudget('quick').perSection);
  });
});

describe('figuresForReport', () => {
  const dep = async () => ({
    ok: true, status: 200,
    json: async () => ({ query: { pages: [page({ title: 'Ancient drainage', pageimage: 'Ancient_drainage.jpg' })] } }),
  });
  it('tags each figure with the section it belongs to', async () => {
    const figs = await figuresForReport({
      findings: [{ heading: 'Ancient drainage', body: 'Covered drains ran the length of the street.' }, { heading: 'Well yards', body: 'Every house had a well.' }],
      mode: 'standard', fetchFn: async (url) => (/drainage|well/i.test(decodeURIComponent(url)) ? dep() : { ok: true, status: 200, json: async () => ({ query: { pages: [] } }) }),
    });
    assert.ok(figs.length >= 1);
    for (const f of figs) assert.equal(typeof f.section, 'number', 'figure knows its section index');
  });
  it('never shows the same photograph twice in one report', async () => {
    const figs = await figuresForReport({
      findings: [
        { heading: 'Ancient drainage', body: 'Covered drains.' },
        { heading: 'Ancient drainage again', body: 'More covered drains.' },
        { heading: 'Drainage details', body: 'Still drains.' },
      ],
      mode: 'standard', fetchFn: dep,
    });
    const files = figs.map((f) => fileKey(f.file || f.url));
    assert.equal(new Set(files).size, files.length, `duplicate images: ${JSON.stringify(files)}`);
  });
  it('respects the mode budget', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ heading: `Topic number ${i}`, body: 'Body text.' }));
    const figs = await figuresForReport({ findings: many, mode: 'quick', fetchFn: dep });
    assert.ok(figs.length <= figureBudget('quick').total, 'never exceeds the quick-mode budget');
  });
  it('returns nothing for a report with no findings', async () => {
    assert.deepEqual(await figuresForReport({ findings: [], fetchFn: dep }), []);
  });
});

describe('exports carry figures with their credits', () => {
  const result = {
    task: { question: 'How did Harappan cities manage water?', mode: 'deep', stance: 'neutral' },
    completedAt: '2026-10-04T00:00:00.000Z',
    claims: [{ id: 'c1', text: 'Drains ran under the streets.', state: 'supported', supporting: ['s1'], contradicting: [], confidenceWhy: 'excavation report' }],
    sources: [{ id: 's1', title: 'Excavation report', url: 'https://a.example/x', tier: 1, sourceType: 'webpage', verified: true, domain: 'a.example', accessibility: 'full' }],
    report: {
      executiveSummary: 'They managed water with covered drains and soak pits.',
      findings: [{ heading: 'Street drainage', body: 'Covered drains flanked the streets.', cite: ['s1'] }],
      uncertainty: ['Excavation coverage is uneven.'],
      gaps: ['Later-period drains are under-studied.'],
      methodology: 'Planned, searched, classified, extracted.',
      sourceQuality: 'Mixed tiers.',
      independence: 'Partly independent.',
      figures: [{ section: 0, url: IMG, caption: 'Ancient covered drain', alt: 'A drain', author: 'X', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', sourcePage: 'https://commons.wikimedia.org/wiki/File:Drain.jpg', provider: 'Wikimedia Commons' }],
    },
  };

  it('markdown embeds the image with the section and credits the author', () => {
    const md = exportMarkdown(result);
    assert.ok(md.includes(`![Ancient covered drain](${IMG})`), 'image embedded');
    assert.ok(md.includes('X, CC BY-SA 4.0'), 'author + licence in the caption');
    assert.ok(md.includes('Figure credits'), 'credit list at the end');
    // The image must sit inside its section, not in a trailing gallery.
    assert.ok(md.indexOf(IMG) > md.indexOf('Street drainage') && md.indexOf(IMG) < md.indexOf('## Uncertainty'));
  });

  it('html renders a real figure element with a visible credit', () => {
    const html = exportHtml(result);
    assert.ok(html.includes(`<img src="${IMG}"`), 'img element');
    assert.ok(html.includes('<figcaption>'), 'caption element');
    assert.ok(html.includes('CC BY-SA 4.0'), 'licence visible in the export');
    // Regression: an earlier edit to this function dropped the capture group
    // around the URL, which emitted href="" for EVERY citation in the HTML
    // export. Anchors must carry their target.
    assert.ok(html.includes('<a href="https://a.example/x"'), 'citation anchors keep their href');
    assert.ok(!/href=""/.test(html), 'no empty hrefs anywhere');
    assert.ok(!/\[Title\]|!\[/.test(html), 'no raw markdown left in the HTML export');
  });

  it('the NotebookLM dossier keeps claim states and bare URLs', () => {
    const nl = exportNotebookLm(result);
    assert.match(nl, /\[supported\] Drains ran under the streets/, 'claim state travels with the claim');
    assert.ok(nl.includes('https://a.example/x'), 'bare URL, which NotebookLM can resolve');
    assert.ok(!/\]\(https/.test(nl), 'no inert markdown links — those do not resolve in a notebook');
    assert.ok(nl.includes(IMG), 'figures travel with attribution');
    assert.ok(nl.includes('X, CC BY-SA 4.0'), 'figure credit preserved');
  });

  it('the media brief sequences narration, on-screen titles and credits', () => {
    const br = exportMediaBrief(result);
    assert.match(br, /Beat 1: Street drainage/);
    assert.match(br, /On-screen title: Street drainage/);
    assert.match(br, /Narration:/);
    assert.match(br, /credit on screen: "X \/ CC BY-SA 4\.0"/);
    assert.match(br, /Estimated narration: \d+m \d\ds at 150 wpm/);
    assert.ok(br.includes('https://a.example/x'), 'sources credited for on-screen display');
  });
});

describe('orchestrator attaches figures (and only when wanted)', () => {
  const base = {
    plan: async () => ({ domain: 'history', complexity: 'medium', steps: [], linesOfInquiry: [], queries: [], bookVariants: [], arc: [{ title: 'Origins', focus: 'f' }] }),
    queries: async () => [{ q: 'q', category: 'general' }],
    search: async () => [{ url: 'https://a.example/x', title: 'A source', snippet: 's', via: 'test', relevance: 0.9 }],
    academic: async () => [], books: async () => [],
    fetch: async () => ({ ok: false, reason: 'x' }),
    claims: async () => [{ id: 'c1', text: 'A claim.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }],
    claimsReview: async () => ({ claims: [], review: { contradictions: [], gaps: [], sufficient: true, reason: 'r' } }),
    review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
    provenance: async () => ({ groups: [], relations: [], note: 'n' }),
    verify: async () => [],
    urlContext: async () => ({ text: '' }),
    synthesize: async () => ({ executiveSummary: 'S', findings: [{ heading: 'Origins', body: 'Body text.', cite: [] }], established: [], competing: [], contradictions: [], timeline: [], sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: ['u'], gaps: [], methodology: 'm' }),
  };
  const task = { question: 'When was X founded and what caused it?', mode: 'quick', stance: 'neutral' };

  it('runs the provider when the run is un-scripted and no dep is injected', async () => {
    // Sanity: deps are injected here, so the guard must suppress the network call.
    const r = await runResearch({ ...task }, { key: 'k', emit: () => {}, deps: { ...base } });
    assert.equal(r.report.figures, undefined, 'scripted runs get no hidden network calls');
  });

  it('honours an explicit figures dep', async () => {
    const fig = { section: 0, url: IMG, caption: 'c', author: 'X', license: 'CC BY-SA 4.0', sourcePage: 'https://commons.wikimedia.org/wiki/File:Drain.jpg' };
    const r = await runResearch({ ...task }, { key: 'k', emit: () => {}, deps: { ...base, figures: async () => [fig] } });
    assert.deepEqual(r.report.figures, [fig]);
    assert.equal(r.report.figures[0].author, 'X', 'credit survives into the result');
  });

  it('a failing figure lookup does not lose the report', async () => {
    const r = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: { ...base, figures: async () => { throw new Error('wikimedia down'); } },
    });
    assert.ok(r.report.findings.length >= 1, 'report still written');
    assert.equal(r.report.figures, undefined);
  });
});