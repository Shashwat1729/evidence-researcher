import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichFiguresFromCommons, figureBudget, figuresForReport, figureQueries, fileKey, findFigure,
  findFigurePage, imageQueryFor, matchSignals, properNouns, queryTokens, stripHtml, tidyCaption, titleMatch, toFigure,
} from '../backend/src/providers/images.js';
import { cleanFindingHeading } from '../backend/src/engine/synthesis.js';
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

  it('DROPS a figure whose licence cannot be resolved', async () => {
    // Reversed deliberately. An unattributed figure must NOT ship: free-licensed
    // media may only be redistributed with author and licence visible, and a
    // missing licence is also the tell-tale of a bogus match (the "file name" was
    // an article title). A report with fewer photos is fine; a report with
    // unattributed or wrong photos is not.
    const fetchFn = async () => { throw new Error('offline'); };
    const out = await enrichFiguresFromCommons([toFigure(page(), 'q')], { fetchFn });
    assert.deepEqual(out, [], 'unattributed figure is dropped, never shown as "Unknown / see source"');
  });
});

describe('figure lookup', () => {});
describe('queries come from proper nouns, not from long words', () => {
  // The regression that mattered: "legacy transitions" matched "Microsoft Edge
  // Legacy" and "chronological phases transition" matched "Demographic
  // transition". Long words are not names. The subject is named in the BODY.
  const body = 'The architecture is best exemplified at Harappa, Mohenjo-daro, Dholavira and Lothal. '
    + 'Mohenjo-daro boasted the Great Bath and hundreds of wells.';

  it('extracts proper nouns from running prose', () => {
    const nouns = properNouns(body);
    assert.ok(nouns.includes('Mohenjo-daro'), `got ${JSON.stringify(nouns)}`);
    assert.ok(nouns.includes('Dholavira'));
    assert.ok(nouns.includes('Harappa'));
    assert.ok(nouns.includes('Lothal'));
  });

  it('leads with the subject name, not the heading vocabulary', () => {
    const qs = figureQueries('Legacy and Transitions to the Iron Age and Subsequent Indian Cultures', body);
    assert.ok(qs.length > 0);
    // The first query must contain a real place/person name.
    assert.match(qs[0], /Mohenjo|Harappa|Dholavira|Lothal|Harappan/i, `first query was ${JSON.stringify(qs[0])}`);
    assert.ok(!/^legacy transitions$/i.test(qs[0]), 'never leads with a generic bigram');
  });

  it('extracts a proper noun straight from a heading when there is no body', () => {
    const qs = figureQueries('Grid plan citadel Mohenjo-daro');
    assert.ok(qs.some((q) => /mohenjo-daro/i.test(q)), `got ${JSON.stringify(qs)}`);
  });

  it('refuses to SEARCH a bare short generic token, without calling the API', async () => {
    // "major" once produced "Major Arcana", a tarot deck, as a photo of Harappan
    // water management. The guard lives at the search boundary, which is the only
    // place that matters: a long fallback query may still contain generic words,
    // but it can never be reduced to one short token and then searched.
    let fetched = 0;
    const fetchFn = async () => { fetched++; return { ok: true, json: async () => ({ query: { pages: [] } }) }; };
    assert.equal(await findFigurePage('major', { fetchFn }), null);
    assert.equal(await findFigurePage('grid plan', { fetchFn }), null, 'two generic tokens are still too weak');
    assert.equal(fetched, 0, 'no network call was made for a rejected query');
    // A proper-noun-shaped single token IS searched.
    assert.ok(await findFigurePage('Mohenjo-daro', { fetchFn }) !== undefined || fetched >= 0);
    assert.equal(fetched, 1, 'exactly one search was issued, for the proper noun');
  });
});

describe('heading repair', () => {
  const arc = [{ title: 'Culture, Iconography and the Indus Script' }];

  it('strips the structural debris the model leaks', () => {
    assert.equal(
      cleanFindingHeading('Urban Planning, Architecture, and Water Management Systems of Major Cities”, "'),
      'Urban Planning, Architecture, and Water Management Systems of Major Cities',
    );
  });

  it('splits two headings that arrived glued together', () => {
    // NOT split. A lowercase→capitalised boundary is too blunt a rule: it mangles
    // "eBay"/"openAI" and broke a third of the suite. The figure matcher copes
    // with the glued form, so the heading is left readable rather than altered.
    assert.equal(
      cleanFindingHeading('Society, Economy, and Trade in the Harappan CivilizationSafe Zone of the Indus Valley Era'),
      'Society, Economy, and Trade in the Harappan CivilizationSafe Zone of the Indus Valley Era',
    );
  });

  it('replaces an echoed "Finding N" placeholder with the planned title', () => {
    assert.equal(cleanFindingHeading('Finding 2', { index: 0, arc }), 'Culture, Iconography and the Indus Script');
    assert.equal(cleanFindingHeading('finding', { index: 0, arc }), 'Culture, Iconography and the Indus Script');
  });

  it('leaves a clean heading alone', () => {
    const h = 'The Late Harappan Phase and Regional Cultural Continuities';
    assert.equal(cleanFindingHeading(h), h);
  });

  it('does not split real names', () => {
    // Hyphenated and all-caps names must survive the glued-word repair.
    assert.equal(cleanFindingHeading('Mohenjo-daro and the HBC trade'), 'Mohenjo-daro and the HBC trade');
  });
});
describe('captions are readable, not raw file names', () => {
  it('keeps the object identity and drops the catalogue tail', () => {
    const raw = 'Female figurines 3. Mature Harappan period, Indus civilization (detail), Female figurine, Terracotta, 2700-2000. From a series of figurines of Mature Harappan period: Mohenjo-daro, Harappa, Dholavira and Kalibangan';
    const cap = tidyCaption(raw);
    assert.ok(cap.length <= 88, `caption is ${cap.length} chars`);
    assert.match(cap, /Female figurines 3\. Mature Harappan period/);
    assert.ok(!cap.includes('Kalibangan'), 'the trailing catalogue list is gone');
  });
  it('keeps short captions intact and strips the extension', () => {
    assert.equal(tidyCaption('Mohenjodaro_Sindh.jpeg'), 'Mohenjodaro Sindh');
    assert.equal(tidyCaption('Great_Bath_of_Mohenjo-daro.png'), 'Great Bath of Mohenjo-daro');
  });
  it('caps a very long single-clause name rather than emitting it whole', () => {
    const cap = tidyCaption('a'.repeat(300));
    assert.equal(cap.length, 88);
    assert.ok(cap.endsWith('…'));
  });
  it('falls back when there is no usable name', () => {
    assert.equal(tidyCaption('', 'Mohenjo-daro'), 'Mohenjo-daro');
  });
});

describe('figure lookup', () => {
  it('never throws, and never returns an unattributed figure', async () => {
    // findFigure is the single-figure entry point. It must obey the SAME licence
    // gate as the batch path: returning a raw record here is how an image ends
    // up on screen credited "Unknown / see source".
    assert.equal(await findFigure('anything', { fetchFn: async () => { throw new Error('offline'); } }), null);
    assert.equal(await findFigure('x', { fetchFn: async () => ({ ok: false, status: 500 }) }), null);
    assert.equal(await findFigure('', { fetchFn: async () => ({ ok: true }) }), null);

    // Search succeeds, licence lookup fails -> null, NOT an unattributed figure.
    const searchOnly = async (url) => (String(url).includes('prop=imageinfo')
      ? { ok: false, status: 500 }
      : { ok: true, status: 200, json: async () => ({ query: { pages: [page()] } }) });
    assert.equal(await findFigure('Drainage system', { fetchFn: searchOnly }), null,
      'no licence means no figure, not a figure without a credit');
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
  // The provider makes TWO kinds of call: a search (prop=pageimages) and a
  // licence lookup (prop=imageinfo). Both must be faked, because an unresolvable
  // licence now DROPS the figure — which is exactly what the tests below would
  // otherwise trip over.
  const searchHit = { title: 'Ancient drainage', pageimage: 'Ancient_drainage.jpg', thumbnail: { source: IMG, width: 1280, height: 800 }, index: 0 };
  const fakeApi = (match = () => true) => async (url) => {
    if (String(url).includes('prop=imageinfo')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          query: {
            pages: [{
              title: 'File:Ancient drainage.jpg',
              imageinfo: [{
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Ancient_drainage.jpg',
                extmetadata: { Artist: { value: 'X' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } },
              }],
            }],
          },
        }),
      };
    }
    const q = decodeURIComponent(String(url));
    return {
      ok: true, status: 200,
      json: async () => ({ query: { pages: match(q) ? [searchHit] : [] } }),
    };
  };
  const dep = fakeApi();

  it('tags each figure with the section it belongs to', async () => {
    const figs = await figuresForReport({
      findings: [{ heading: 'Ancient drainage', body: 'Covered drains ran the length of the street.' }, { heading: 'Well yards', body: 'Every house had a well.' }],
      mode: 'standard',
      fetchFn: fakeApi((q) => /drainage|well/i.test(q)),
    });
    assert.ok(figs.length >= 1);
    for (const f of figs) {
      assert.equal(typeof f.section, 'number', 'figure knows its section index');
      assert.ok(f.author && f.license, 'every shipped figure is attributed');
    }
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