import { previewUrl } from '../src/catalog.mjs';

const rows = [
  {
    id: 3087275, modelId: 2744788, version: 'v1.0', base: 'SDXL 1.0',
    model: 'Linocut Relief Print - Turn Anything Into a Carved Block Print (Original Style)',
    creator: 'Booyaka', image: 135405057, imageKey: '22b36de2-61e3-4f94-aba9-f8974614257a',
  },
  {
    id: 3461981, modelId: 3007062, version: 'MOSS Image Base v1', base: 'MOSS Image',
    model: 'LINOCUT', creator: 'Silbrio', image: 148544651, imageKey: '9bc5eb2a-8560-44fd-a4a7-44287f5bf79f',
  },
  {
    id: 1006035, modelId: 899122, version: 'v1.0', base: 'Flux.1 D',
    model: 'Linocut [FLUX]', creator: 'appelsiensam', image: 37186256, imageKey: 'c03b5668-c008-47cd-9b9b-44cc46da1d8f',
  },
];

export function linocutSample(origin) {
  const candidates = rows.map(({ image, imageKey, ...row }) => {
    const url = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' + imageKey + '/original=true/' + imageKey + '.jpeg';
    return {
      ...row, type: 'LORA', formats: [],
      link: new URL('/models/' + row.modelId + '?modelVersionId=' + row.id, origin).href,
      examples: [{ id: image, url, preview: previewUrl(url), link: new URL('/images/' + image, origin).href, recorded: [] }],
    };
  });
  return {
    target: { kind: 'text', value: 'linocut' }, candidates, shortlisted: candidates, related: {}, flows: [],
  };
}
