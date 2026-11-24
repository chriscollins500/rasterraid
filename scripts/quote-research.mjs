import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SITE_ORIGINS } from '../src/catalog.mjs';
import { catalogResearch } from '../src/catalog-research.mjs';
import { discover } from '../src/search.mjs';
import { discoverReport } from '../src/report.mjs';
import { inspectReferenceDocument, inspectReferenceImage, pairReferenceSidecars } from '../src/reference-provenance.mjs';
import { reportResearchPlans } from '../src/report-research.mjs';
import { galleryCompositionResearch, gallerySimilarityResearch, visualResearch } from '../src/visual-research.mjs';
import { RESEARCH_MODEL as paidModel, researchPlans } from '../src/research.mjs';
import { resultGroups } from '../src/view.js';
import { getOrchestrationCredential, orchestrationClient } from './orchestration.mjs';
import { appEstimateBody, estimateAppWorkflow, quotePrice } from '../src/quotes.mjs';
import { markWorkflowBody, workflowRecoveryStep } from '../src/workflow-recovery.mjs';
import { exampleSetupMedia, recordedPictureExample, sidecarComparisonExample, workflowUpgradeExample } from './reference-fixtures.mjs';
import { visualQuoteBrief, visualQuoteFixture } from './visual-quote-fixture.mjs';
import { publicVisualBrief, visualBriefCues, visualBriefExample } from './visual-composition-fixture.mjs';
import { soundQuoteBrief, soundQuoteFixture } from './sound-quote-fixture.mjs';
import { sceneQuoteBrief, sceneQuoteFixture } from './scene-quote-fixture.mjs';

const args = process.argv.slice(2);
const origin = args.includes('--red') ? SITE_ORIGINS[1] : SITE_ORIGINS[0];
const useExistingCli = args.includes('--use-existing-cli');
const useAppEstimate = args.includes('--app-estimate');
const recoveryQuote = args.includes('--recovery-quote');
const catalogExamples = args.includes('--catalog-examples');
const quickToolsExample = args.includes('--quick-tools-example');
const reportExamples = args.includes('--report-examples');
const mediaModelExamples = args.includes('--media-model-examples');
const setupExamples = args.includes('--setup-examples');
const pairExamples = args.includes('--example-pair-examples');
const storyExamples = args.includes('--story-examples');
const coverageExamples = args.includes('--coverage-examples');
const guideExamples = args.includes('--guide-examples');
const referenceExamples = args.includes('--reference-examples');
const sidecarExamples = args.includes('--sidecar-examples');
const aiServiceExamples = args.includes('--ai-service-examples');
const upgradeExamples = args.includes('--upgrade-examples');
const visualExamples = args.includes('--visual-examples');
const neighborExamples = args.includes('--visual-neighbor-examples');
const referenceBriefExamples = args.includes('--visual-brief-examples');
const compositionExamples = args.includes('--visual-composition-examples') || referenceBriefExamples;
const soundExamples = args.includes('--sound-examples');
const sceneExamples = args.includes('--scene-examples');
const collectionExamples = args.includes('--collection-examples');
const portfolioExamples = args.includes('--portfolio-examples');
const creatorExamples = args.includes('--creator-examples');
const releaseExamples = args.includes('--release-examples');
const descriptiveMediaExamples = args.includes('--descriptive-media-examples');
const groupedExamples = catalogExamples || quickToolsExample || reportExamples || coverageExamples || guideExamples || referenceExamples || upgradeExamples ||
  visualExamples || soundExamples || collectionExamples || sceneExamples || descriptiveMediaExamples || sidecarExamples || aiServiceExamples ||
  portfolioExamples || creatorExamples || releaseExamples || neighborExamples || compositionExamples || mediaModelExamples || setupExamples || pairExamples || storyExamples;
const appCliIndex = args.indexOf('--app-cli');
const appCli = appCliIndex >= 0 ? args[appCliIndex + 1] : null;
const run = promisify(execFile);

async function runLocalCli(argumentsList) {
  const { stdout } = await run(appCli, ['--no-update-check', '--no-color', ...argumentsList], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, CIVITAI_BASE_URL: origin },
    timeout: 20_000,
    maxBuffer: 32_768,
    windowsHide: true,
  });
  return stdout;
}

async function appCredential({ forEstimate = false } = {}) {
  try {
    // The hosted estimate route requires the budgeted scope. The temporary
    // token is held in memory and is only passed to the estimate-only client.
    const flags = forEstimate ? ['--spend', '--budget', '20'] : [];
    const stdout = await runLocalCli(['app', 'dev-token', 'rasterraid', ...flags]);
    return stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(line));
  } catch {
    throw new Error('The CLI could not mint the requested App preview token.');
  }
}

try {
  if (appCliIndex >= 0 && !appCli) throw new Error('The --app-cli option requires the path of the installed Civitai CLI.');
  if (useAppEstimate && !appCli) throw new Error('App estimates require --app-cli.');
  if (recoveryQuote && (!useAppEstimate || !args.includes('--example') || groupedExamples)) {
    throw new Error('Recovery quotes require the App Linocut example.');
  }
  if ((portfolioExamples || releaseExamples || creatorExamples) && !useAppEstimate) throw new Error('Release and creator examples require the App estimate route.');
  if ((neighborExamples || compositionExamples) && !useAppEstimate) throw new Error('Gallery similarity examples require the App estimate route.');
  if (mediaModelExamples && !useAppEstimate) throw new Error('Media model examples require the App estimate route.');
  if ((setupExamples || pairExamples) && !useAppEstimate) throw new Error('Example setup estimates require the App estimate route.');
  if (storyExamples && !useAppEstimate) throw new Error('Story examples require the App estimate route.');
  if (quickToolsExample && !useAppEstimate) throw new Error('The Quick search example requires the App estimate route.');
  const token = appCli ? await appCredential() : undefined;
  if (appCli && !token) throw new Error('No App preview token was returned.');

  const examples = collectionExamples ? [{ scope: 'report', reportType: 'collection', query: origin + '/collections/18549055' }]
    : portfolioExamples ? [{ scope: 'report', reportType: 'portfolio', query: '', sort: 'Newest' }]
    : creatorExamples ? [{ scope: 'report', reportType: 'creator', query: '@Booyaka' }]
    : releaseExamples ? [{ scope: 'report', reportType: 'release', query: origin + '/models/4384?modelVersionId=128713' }]
    : mediaModelExamples ? [{ scope: 'report', reportType: 'style', query: 'DreamShaper', reportSources: ['models', 'gallery', 'videos', 'posts'] }]
    : setupExamples ? [{ scope: 'report', reportType: 'trace', query: origin + '/images/' + exampleSetupMedia.picture }]
    : pairExamples ? [{ scope: 'report', reportType: 'examplePair', query: exampleSetupMedia.picture + ' ' + exampleSetupMedia.clip }]
    : storyExamples ? [{ scope: 'report', reportType: 'stories', query: 'Plan a short illustrated story about cyberpunk' }]
    : neighborExamples ? [{ scope: 'gallery', query: origin + '/images?similarTo=135405057' },
      { scope: 'gallery', query: origin + '/images?similarTo=145616716' },
      { scope: 'videos', query: origin + '/images?similarTo=80205619' }]
    : compositionExamples ? [referenceBriefExamples ? visualBriefExample : { scope: 'gallery', query: '' }]
    : sceneExamples ? [sceneQuoteBrief] : soundExamples ? [soundQuoteBrief] : visualExamples ? [visualQuoteBrief(origin)] : upgradeExamples ? [workflowUpgradeExample(origin)] : sidecarExamples ? [
    { scope: 'report', reportSources: ['models', 'gallery'], query: '' },
  ] : referenceExamples ? [
    { scope: 'report', reportType: 'style', query: '' },
  ] : guideExamples ? [
    { scope: 'report', reportType: 'guide', query: 'Article #1043' },
  ] : coverageExamples ? [
    { scope: 'apps', query: 'wallpaper' },
    { scope: 'report', reportType: 'workflow', query: 'comfyui', reportSources: ['apps', 'articles', 'tools'] },
  ] : reportExamples ? [
    { scope: 'report', reportType: 'style', query: 'linocut' },
    { scope: 'report', reportType: 'media', query: 'citypop' },
    { scope: 'report', reportType: 'trace', query: origin + '/images/135405057' },
  ] : descriptiveMediaExamples ? [
    { scope: 'gallery', query: 'ginger cat on a sunny window ledge' },
    { scope: 'videos', query: 'motorcycle driving through rain at night' },
  ] : aiServiceExamples ? [
    { scope: 'aiServices', query: 'transcription', serviceMatch: 'keywords' },
    { scope: 'report', reportType: 'aiWorkflow', query: 'video caption' },
  ] : quickToolsExample ? [{ scope: 'all', query: 'ComfyUI' }] : catalogExamples ? [
    { scope: 'articles', query: 'readable canvases' },
    { scope: 'audio', query: 'citypop' },
    { scope: 'gallery', query: 'cat' },
    { scope: 'videos', query: 'motorcycle' },
    { scope: 'tools', query: 'Image MetaHub' },
    { scope: 'comics', query: 'New Horizon' },
  ] : [args.includes('--example') ? { query: 'linocut', baseModel: '', resourceType: '', exclude: '', scope: 'all' }
    : { query: 'linocut', baseModel: 'SDXL 1.0', resourceType: 'LORA', exclude: 'photorealistic' }];
  const context = { origin, token, hosted: Boolean(appCli), browsingLevel: 3 };
  if (collectionExamples || portfolioExamples) {
    if (!token) throw new Error('This report sample requires a signed App catalog token.');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    context.signedIn = /^user:[1-9]\d*$/u.test(claims.sub);
    context.viewerUserId = context.signedIn ? Number(claims.sub.slice(5)) : null;
    context.scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
    context.browsingLevel = claims.maxBrowsingLevel & claims.viewerBrowsingLevel;
  }
  const recordedReferences = referenceExamples ? [await inspectReferenceImage(recordedPictureExample())] : undefined;
  const editPairs = sidecarExamples ? [pairReferenceSidecars(...await Promise.all(sidecarComparisonExample().map(inspectReferenceDocument)))] : undefined;
  const visualBrief = compositionExamples ? await publicVisualBrief(context, referenceBriefExamples ? { cues: visualBriefCues } : undefined) : undefined;
  const results = sceneExamples ? [await sceneQuoteFixture(context, discoverReport)]
    : soundExamples ? [await soundQuoteFixture(context, discover, resultGroups)] : visualExamples ? [await visualQuoteFixture(context, discoverReport, discover)]
    : await Promise.all(examples.map(filters => (filters.scope === 'report' ? discoverReport : discover)(context, filters, { recordedReferences, editPairs, visualBrief })));
  if (!groupedExamples && !results[0].shortlisted.length) throw new Error('The test brief did not find an eligible version.');

  let client;
  let quoteToken;
  let freeModel;
  let balanceBefore;
  if (useAppEstimate) {
    quoteToken = await appCredential({ forEstimate: true });
    if (!quoteToken) throw new Error('No temporary App estimate credential was returned.');
    balanceBefore = await runLocalCli(['buzz', '--json']).catch(() => null);
  } else {
    client = orchestrationClient(await getOrchestrationCredential({ useExistingCli }));
    const available = await client.listServices({ category: 'chat', query: 'gpt-6-luna', limit: 10 });
    const service = available.items?.find(item => item.id === 'chat/' + paidModel);
    if (!service || service.status !== 'available') throw new Error('The requested research model is not available in Orchestration.');
    const freeTier = await client.freeTier().catch(() => null);
    const eligible = freeTier?.enabled
      ? freeTier.models?.find(item => item.key === 'qwen3.8-chat' && item.remaining > 0)
      : undefined;
    freeModel = eligible?.airs?.find(id => id === 'civitai/qwen3.8');
  }
  async function getQuotes(plans, { marked = false } = {}) {
    const quotes = [];
    for (const plan of plans) {
      const plainBody = useAppEstimate ? appEstimateBody(plan) : plan.body;
      const body = marked ? markWorkflowBody(plainBody, await workflowRecoveryStep('rasterraid-estimate-' + plan.id)) : plainBody;
      const exactBodySha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const shared = { id: plan.id, title: plan.title, model: plan.id === 'free' ? freeModel :
        plan.body.steps.find(step => step.$type === 'chatCompletion')?.input.model ?? null,
      steps: plan.body.steps.map(step => step.name), tier: plan.body.tier, appBodyKind: useAppEstimate ? body.kind : null, exactBodySha256 };
      try {
        const quote = useAppEstimate ? await estimateAppWorkflow(origin, quoteToken, body) : await client.estimate(body);
        const price = quotePrice(quote);
        quotes.push({
          ...shared,
          status: quote.status ?? null,
          priced: price !== null,
          buzz: price?.total ?? null,
          base: quote.cost?.base ?? null,
          authorFee: price?.authorFee ?? null,
          authorFeeItemized: price?.authorFee != null,
          errorCode: quote.errorCode ?? null,
          reportedTransactionCount: Array.isArray(quote.transactions) ? quote.transactions.length : null,
          costFactors: Object.fromEntries(Object.entries(quote.cost?.factors ?? {}).filter(([, value]) => typeof value === 'number')),
        });
      } catch (error) {
        quotes.push({ ...shared, priced: false, status: error.status ?? null, errorCode: error.code ?? null, details: error.details ?? [] });
        if (error.status === 429) break;
      }
    }
    return quotes;
  }

  const scenarios = [];
  for (const [index, filters] of examples.entries()) {
    const result = results[index];
    if (compositionExamples) {
      const comparison = galleryCompositionResearch(result, origin);
      if (!comparison) throw new Error('Expected an eligible public reference composition.');
      if (referenceBriefExamples && !result.visualComposition.referenceMatchesAdded) throw new Error('The reference brief did not add eligible previews.');
      const quotes = await getQuotes(comparison.plans);
      scenarios.push({ brief: filters, references: comparison.references.map(({ link, cue }) => ({ link, cue })),
        ...(referenceBriefExamples && { referenceMatchesAdded: result.visualComposition.referenceMatchesAdded,
          catalogPaths: result.visualComposition.checked }),
        comparisons: comparison.plans.map(({ id, inputs }) => ({ id, inputs })), quotes });
    } else if (neighborExamples) {
      const comparison = gallerySimilarityResearch(result, origin);
      if (!comparison || comparison.plans.at(-1).inputs.length < 4) throw new Error('Expected an eligible reference and several previews.');
      const quotes = await getQuotes(comparison.plans);
      scenarios.push({ brief: filters, reference: comparison.reference.link,
        comparisons: comparison.plans.map(({ id, inputs }) => ({ id, inputs })), quotes });
    } else if (sceneExamples || soundExamples) {
      if (result.picks?.length !== 2) throw new Error('Both Citypop samples must be eligible.');
      const quotes = await getQuotes(result.plans);
      scenarios.push({ brief: filters, selection: result.selection, sources: result.sources, quotes });
    } else if (filters.scope === 'report') {
      const visual = visualExamples ? visualResearch(result.report, origin, result.selection) : null;
      if (visualExamples && visual?.picks.length !== 2) throw new Error('Both public visual quote samples must be eligible.');
      const plans = visual?.plans ?? reportResearchPlans(result.report);
      if (setupExamples && !result.report.exampleSetup?.recorded.some(row => row.model && row.weights.length)) {
        throw new Error('Expected a public example with verified model versions and recorded strengths.');
      }
      if (pairExamples && (!result.report.exampleComparison?.examples.every(({ item, post }) => item && post) ||
          plans.at(-1)?.inputs?.length !== 2)) throw new Error('Expected two eligible examples, their verified posts, and a visual comparison.');
      if (storyExamples && (result.report.story?.toolSource !== 'metadata' || !result.report.story?.profile ||
          !result.report.evidence.some(item => item.group === 'apps') || !plans.at(-1)?.inputs?.length)) {
        throw new Error('Expected an evidence-led story plan with a tool hint, verified creator, and visible previews.');
      }
      const quotes = await getQuotes(plans);
      scenarios.push({ brief: filters, sources: result.report.rails.map(({ scope, status, count }) => ({ scope, status, count })),
        ...(visual && { visualPicks: result.selection, linkedSourceCount: visual.sources.length }),
        ...(collectionExamples && { collection: result.report.collectionTrace, versions: result.candidates.map(candidate => candidate.id) }),
        ...(mediaModelExamples && { mediaModelTrace: result.report.mediaModelTrace,
          verifiedLinks: result.report.connections.map(({ kind, items }) => ({ kind, sources: items.map(item => item.link) })) }),
        ...(setupExamples && { setup: result.report.exampleSetup,
          comparisons: plans.filter(plan => plan.inputs?.length).map(({ id, inputs }) => ({ id, inputs })) }),
        ...(pairExamples && { examples: result.report.exampleComparison.examples.map(({ item, post, postModel }) => ({
          link: item.link, post: post.link, postModel: postModel?.link,
        })), comparisons: plans.filter(plan => plan.inputs?.length).map(({ id, inputs }) => ({ id, inputs })) }),
        ...(storyExamples && { story: { topic: result.report.story.topic, reference: result.report.story.reference,
          profile: result.report.story.profile, runtime: result.report.story.runtime, toolSource: result.report.story.toolSource,
          stages: result.report.story.stages.map(stage => ({ title: stage.title, links: stage.items.map(item => item.link) })) } }),
        connections: result.report.connections.length, quotes });
    } else if (groupedExamples) {
      const filter = quickToolsExample ? 'tools' : filters.scope === 'audio' ? 'all' : filters.scope;
      const catalog = catalogResearch(result, resultGroups(result), filter, origin);
      const quotes = await getQuotes(catalog.plans);
      scenarios.push({ brief: filters, ...(quickToolsExample && { filter }),
        picks: catalog.picks.map(({ link, title, group }) => ({ link, title, group })), quotes });
    } else {
      const plans = researchPlans(result, filters, { model: paidModel, freeModel });
      const quotes = await getQuotes(plans);
      const recoveryQuotes = recoveryQuote ? await getQuotes(plans, { marked: true }) : null;
      scenarios.push({
        brief: filters, firstSearchVersionIds: result.baseline, combinedVersionIds: result.combined,
        shortlist: result.shortlisted.map(candidate => ({
          modelId: candidate.modelId, versionId: candidate.id, name: candidate.model, base: candidate.base,
          exampleIds: candidate.examples.map(image => image.id), usableImageUrls: candidate.examples.filter(image => image.url).length,
        })),
        collectionMatches: result.related.collections?.map(({ link, title, preview }) => ({ link, title, hasPreview: Boolean(preview) })) ?? [],
        routes: result.flows, eligibleFreeModel: freeModel ?? null,
        quotes, ...(recoveryQuotes && { recoveryQuotes }),
      });
    }
  }

  const balanceAfter = useAppEstimate ? await runLocalCli(['buzz', '--json']).catch(() => null) : null;
  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    catalogOrigin: origin,
    catalogCredential: appCli ? 'read-only App preview token' : 'anonymous Site API',
    pricing: useAppEstimate ? 'RasterRaid App /api/v1/blocks/workflows/estimate' : 'Direct Orchestration REST with whatif=true',
    balanceRecordUnchanged: useAppEstimate && balanceBefore && balanceAfter ? balanceBefore === balanceAfter : null,
    ...(groupedExamples ? { scenarios, quotes: scenarios.flatMap(scenario => scenario.quotes) } : scenarios[0]),
  }, null, 2));
  const expected = sceneExamples || neighborExamples || compositionExamples ? 2
    : visualExamples || soundExamples || collectionExamples || sidecarExamples || portfolioExamples || releaseExamples || mediaModelExamples || setupExamples || pairExamples || storyExamples ? 3 : null;
  if (scenarios.some(scenario => expected ? scenario.quotes.length !== expected || scenario.quotes.some(quote => !quote.priced)
    : !scenario.quotes.some(quote => quote.priced && quote.tier === 'paid'))) process.exitCode = 1;
  if (recoveryQuote && (!balanceBefore || balanceBefore !== balanceAfter || scenarios.some(({ quotes, recoveryQuotes }) =>
    !quotes.length || recoveryQuotes.length !== quotes.length || quotes.some((quote, index) => {
      const marked = recoveryQuotes[index];
      return !quote.priced || !marked.priced || quote.id !== marked.id || quote.exactBodySha256 === marked.exactBodySha256 ||
        quote.buzz !== marked.buzz || quote.authorFee !== marked.authorFee;
    })))) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
