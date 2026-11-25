import assert from 'node:assert/strict';
import test from 'node:test';

const source = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { compileModelBrief, mergeModelBriefFilters } = await import(source + 'model-brief.mjs');
const { quickSearchIntent } = await import(source + 'search-intent.mjs');
const registry = { bases: ['SDXL 1.0', 'SD 1.5', 'Pony', 'Flux.1 D', 'Aurora 7'],
  types: [{ value: 'LORA', label: 'LoRA' }, { value: 'Checkpoint', label: 'Checkpoint' },
    { value: 'VisionLanguage', label: 'Vision-Language Model' }], formats: ['SafeTensor', 'GGUF', 'Core ML'] };

test('typed model requirements produce exact plans in English, Spanish, and French', () => {
  const exact = { query: 'Linocut Relief Print', filters: {
    baseModel: 'SDXL 1.0', resourceType: 'LORA', modelAuthor: 'Booyaka', fileFormat: 'SafeTensor',
  } };
  for (const phrase of ['Find SDXL LoRAs for Linocut Relief Print by @Booyaka in SafeTensor',
    'Buscar LoRAs SDXL para Linocut Relief Print de @Booyaka en formato SafeTensor',
    'Trouver des LoRA SDXL pour Linocut Relief Print par @Booyaka au format SafeTensor']) {
    assert.deepEqual(compileModelBrief(phrase, registry), exact, phrase);
    assert.equal(quickSearchIntent(phrase), null, 'Enter must retain the original draft');
  }
});

test('typed clauses preserve disjunction and the exact subject', () => {
  const tests = [
    ['Show free Pony or SDXL LoRAs for linocut without "anime portrait"', 'linocut',
      { baseModel: ['Pony', 'SDXL 1.0'], resourceType: 'LORA', downloadAccess: 'free', exclude: 'anime portrait' }],
    ['Show LoRAs free for Free Fall', 'Free Fall', { resourceType: 'LORA', downloadAccess: 'free' }],
    ['Find SD 1.5 checkpoints or LoRAs for landscapes with Civitai generation', 'landscapes',
      { baseModel: 'SD 1.5', resourceType: ['Checkpoint', 'LORA'], supportsGeneration: 'true' }],
    ['Buscar modelos gratis para acuarela sin anime', 'acuarela', { downloadAccess: 'free', exclude: 'anime' }],
    ['Trouver des LoRAs gratuits SDXL pour linogravure', null],
    ['Trouver des LoRA SDXL gratuits pour linogravure avec génération Civitai', 'linogravure',
      { baseModel: 'SDXL 1.0', resourceType: 'LORA', downloadAccess: 'free', supportsGeneration: 'true' }],
    ['Find models for linocut in Core ML format by @artist', 'linocut', { fileFormat: 'Core ML', modelAuthor: 'artist' }],
    ['Find SDXL LoRAs for "Linocut in GGUF" in safetensors', 'Linocut in GGUF',
      { baseModel: 'SDXL 1.0', resourceType: 'LORA', fileFormat: 'SafeTensor' }],
    ['Find checkpoints for rain in Cairo in GGUF', 'rain in Cairo', { resourceType: 'Checkpoint', fileFormat: 'GGUF' }],
    ['Find Aurora 7 Vision-Language Model for scene description', 'scene description',
      { baseModel: 'Aurora 7', resourceType: 'VisionLanguage' }],
  ];
  for (const [phrase, query, filters] of tests) assert.deepEqual(compileModelBrief(phrase, registry), query ? { query, filters } : null, phrase);
});

test('ambiguous, unsupported, and retired values stay out of typed filter plans', () => {
  for (const phrase of ['DreamShaper', 'Find SDXL LoRAs for', 'Find SDXL LoRAs for "paint', 'Find LoRAs for art by @',
    'Find Flux LoRAs for portraits', 'Find SDXL and Pony LoRAs for portraits', 'Find SDXL LoRAs for art in format TIFF',
    'Find SDXL free LoRAs for portraits', 'Find free SDXL LoRAs free for portraits',
    'Find LoRAs for portraits without anime or line art', 'Find LoRAs for scenic prints by @creator by @other',
    'Find models for https://civitai.com/models/2744788', 'Find my downloads for SDXL',
    'Find SDXL LoRAs for mon\u202Eotone', 'Find LoRAs for portraits\nby @creator']) {
    assert.equal(compileModelBrief(phrase, registry), null, phrase);
  }
  assert.equal(compileModelBrief('Find SDXL LoRAs for Linocut', { ...registry, bases: ['Pony'] }), null);
  assert.equal(compileModelBrief('Find SDXL LoRAs for Linocut', { ...registry, types: [{ value: 'Checkpoint', label: 'Checkpoint' }] }), null);
});

test('existing selections are intersected and additional constraints never replace them', () => {
  const requested = { baseModel: ['SDXL 1.0', 'Pony'], resourceType: 'LORA', modelAuthor: 'Booyaka', exclude: 'anime' };
  const selected = { category: 'printmaking', baseModel: ['SD 1.5', 'SDXL 1.0'], modelAuthor: '@booyaka',
    downloadAccess: 'free', exclude: 'furniture' };
  assert.deepEqual(mergeModelBriefFilters(requested, selected), { filters: {
    baseModel: 'SDXL 1.0', resourceType: 'LORA', modelAuthor: 'Booyaka', exclude: 'furniture, anime',
  } });
  assert.deepEqual(mergeModelBriefFilters(requested, { ...selected, baseModel: 'Flux.1 D' }), { conflict: 'baseModel' });
  assert.deepEqual(mergeModelBriefFilters(requested, { ...selected, modelAuthor: 'NewCreator' }), { conflict: 'modelAuthor' });
  assert.deepEqual(mergeModelBriefFilters({ downloadAccess: 'free' }, { downloadAccess: 'paid' }), { conflict: 'downloadAccess' });
  assert.deepEqual(mergeModelBriefFilters({ exclude: 'more' }, { exclude: 'a'.repeat(197) }), { conflict: 'exclude' });
  assert.deepEqual(selected.baseModel, ['SD 1.5', 'SDXL 1.0']);
});
