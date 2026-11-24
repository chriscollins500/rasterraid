import { randomUUID } from 'node:crypto';
import { mediaUrl, text } from '../src/catalog.mjs';
import { soundMaximumSeconds } from '../src/sound-analysis.mjs';
import { MOCK_API } from './client.mjs';

export const SIMULATION_WORKFLOWS = MOCK_API + '/workflows/';
const expiry = 30 * 60_000;
const stepPrice = { chatCompletion: 3, transcription: 2, audioCaptioning: 1, multimodalEmbedding: 1,
  videoFrameExtraction: 1, mediaCaptioning: 1 };
const namePattern = /^[a-z][a-z\d_-]{0,31}$/u;
const operationPattern = /^[a-z\d_-]{1,64}$/iu;
const frameReference = step => step.$type === 'mediaCaptioning' && step.input?.mediaUrl?.$ref;

function workflowSteps(body) {
  const steps = body?.steps;
  if (body?.kind !== 'workflow' || !Array.isArray(steps) || !steps.length || steps.length > 8 ||
      steps.some(step => !Object.hasOwn(stepPrice, step?.$type) || !namePattern.test(step.name ?? '') || !step.input) ||
      steps.some(step => step.$type === 'multimodalEmbedding' && (!Number.isInteger(step.input.dimensions) ||
        step.input.dimensions < 16 || step.input.dimensions > 4096)) ||
      new Set(steps.map(step => step.name)).size !== steps.length) return null;
  const frames = new Set();
  for (const step of steps) {
    if (step.$type === 'videoFrameExtraction') {
      const { videoUrl, startTime, maxFrames } = step.input;
      if (!mediaUrl(videoUrl) || !Number.isFinite(startTime) || startTime < 0 || startTime >= soundMaximumSeconds || maxFrames !== 1) return null;
      frames.add(step.name);
    }
    if (step.$type === 'mediaCaptioning') {
      const url = step.input.mediaUrl;
      if (typeof url === 'string' ? !mediaUrl(url) : url?.path !== 'output.frames[0].url' ||
          Object.keys(url).length !== 2 || !frames.has(frameReference(step))) return null;
    }
  }
  return steps;
}

function sampleOutput(step, producer) {
  if (step.$type === 'transcription') return { output: { text: 'Simulated transcript.', timeStamps: [
    { startTime: 0, endTime: .3, text: 'Simulated words' },
    { startTime: .3, endTime: .6, text: 'from the selected clip.' },
  ] } };
  if (step.$type === 'videoFrameExtraction') return { output: { totalFramesExtracted: 1 } };
  if (step.$type === 'mediaCaptioning') return { output: { caption: producer
    ? 'Simulated description of the colors and layout in the frame near ' + producer.input.startTime + ' seconds.'
    : 'Simulated description of the selected public media.' } };
  if (step.$type === 'audioCaptioning') return { output: { hasAudio: true, results: { sample: {
    text: 'Simulated music description for the selected clip.', caption: 'Simulated music description for the selected clip.',
    bpm: '104', keyScale: 'D minor', timeSignature: '4/4', language: 'English',
  } } } };
  if (step.$type === 'multimodalEmbedding') {
    const { model, dimensions } = step.input;
    const relevance = step.input.text ? 1 : step.name.endsWith('_1') ? .8 : .45;
    const embedding = Array(dimensions).fill(0);
    embedding[0] = relevance;
    embedding[1] = Math.sqrt(1 - relevance ** 2);
    return { output: { model, dimensions, modelRevision: 'simulation', profile: 'fixture', precision: 'float32', embedding } };
  }
  const notes = {
    report_brief: 'A real run would combine the attached Civitai listings into a sourced recommendation.',
    report_source_check: 'A real run would check exact IDs and distinguish catalog links from recorded generation settings.',
    report_fit: 'A real run would compare the selected evidence against your search and model filters.',
    report_alternatives: 'A real run would suggest alternatives from the supplied listings and identify missing information.',
    report_picture_check: 'A real run would compare the selected pictures and cite the source for each observation.',
    report_synthesis: 'A real run would use the completed research and its sources to explain the strongest option and what to check next.',
    visual_picture_review: 'Simulated comparison of the selected public example pictures.',
    visual_catalog_check: 'Simulated check of the supplied Civitai sources and documented relationships.',
  };
  const instruction = step.input.messages?.[0]?.content;
  const note = notes[step.name] ?? (typeof instruction === 'string' && (
    instruction.startsWith('Summarize what the completed checks establish') ? notes.report_synthesis :
    instruction.startsWith('Describe visible style and layout.') ? notes.visual_picture_review :
    /^(?:Audit the supplied Civitai catalog leads|Check recorded links between the selected media)/u.test(instruction) ? notes.visual_catalog_check : null));
  return { textOutputs: [text(note || 'A real run would analyze the evidence associated with this step.', 360)] };
}

export function createWorkflowSimulation({ now = Date.now, failStep = null } = {}) {
  const jobs = new Map();
  const operations = new Map();
  const response = (status, value) => ({ status, body: { simulated: true, ...value } });
  const error = (status, message) => response(status, { error: message });
  function snapshot(run) {
    const elapsed = (run.canceledAt ?? now()) - run.startedAt;
    const duration = 400 + run.steps.length * 400;
    const status = run.canceledAt !== undefined ? 'canceled' : elapsed < 400 ? 'pending' : elapsed < duration ? 'processing'
      : failStep !== null && failStep < run.steps.length ? 'failed' : 'succeeded';
    const completed = Math.max(0, Math.floor((elapsed - 400) / 400));
    const steps = [];
    const composed = run.steps.some(frameReference);
    for (const [index, step] of run.steps.entries()) {
      const reference = frameReference(step);
      const producer = reference && steps.find(row => row.name === reference);
      const canComplete = composed ? index !== failStep && (!reference || producer?.status === 'succeeded')
        : failStep === null || index < failStep;
      const succeeded = index < completed && canComplete;
      const stepStatus = succeeded ? 'succeeded' : status === 'failed' && index === failStep ? 'failed'
        : ['canceled', 'failed'].includes(status) ? 'canceled' : index === completed && status === 'processing' ? 'processing' : 'pending';
      steps.push({ name: step.name, $type: step.$type, status: stepStatus,
        ...(succeeded ? sampleOutput(step, reference && run.steps.find(row => row.name === reference)) : {}) });
    }
    return { workflowId: run.id, status, steps, cost: {
      total: steps.filter(step => step.status === 'succeeded').reduce((sum, step) => sum + stepPrice[step.$type], 0),
    } };
  }
  return function handle(method, path, input) {
    for (const [key, run] of jobs) if (now() - run.startedAt >= expiry) {
      operations.delete(run.operation);
      jobs.delete(key);
    }
    const route = path.slice(SIMULATION_WORKFLOWS.length);
    if (!path.startsWith(SIMULATION_WORKFLOWS) || !['estimate', 'submit', 'poll', 'cancel', 'query'].includes(route)) {
      return error(404, 'Simulation route not found.');
    }
    if (method !== 'POST') return error(405, 'Use POST for this simulation.');
    if (route === 'query') {
      const { limit = 24, cursor } = input ?? {};
      const offset = cursor === undefined ? 0 : /^offset-[1-9]\d{0,2}$/u.test(cursor) ? Number(cursor.slice(7)) : -1;
      if (offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) return error(400, 'Choose a valid history page.');
      const workflows = Array.from(jobs.values()).reverse().slice(offset, offset + limit).map(job => {
        const { workflowId, status, cost } = snapshot(job);
        return { workflowId, status, cost: cost.total, createdAt: job.startedAt };
      });
      return response(200, { workflows, cursor: offset + limit < jobs.size ? 'offset-' + (offset + limit) : null });
    }
    if (route === 'estimate' || route === 'submit') {
      const steps = workflowSteps(input?.body);
      if (!steps) return error(400, 'Choose a supported simulated workflow.');
      if (route === 'estimate') return response(200, { snapshot: {
        workflowId: 'whatif', status: 'pending', cost: { total: 1 + steps.reduce((sum, step) => sum + stepPrice[step.$type], 0), authorFee: 1 },
      } });
      const operation = input?.idempotencyKey;
      if (typeof operation !== 'string' || !operationPattern.test(operation)) return error(400, 'Operation key required.');
      const existing = operations.get(operation);
      const request = JSON.stringify(input.body);
      if (existing) {
        return existing.request === request ? response(200, { snapshot: snapshot(existing) }) : error(409, 'This operation is bound to a different request.');
      }
      if (jobs.size >= 128) return error(503, 'The simulation has too many open runs.');
      const job = { id: randomUUID(), operation, request, steps, startedAt: now() };
      jobs.set(job.id, job);
      operations.set(operation, job);
      return response(200, { snapshot: snapshot(job) });
    }
    const job = jobs.get(input?.workflowId);
    if (!job) return error(404, 'Simulated workflow not found.');
    if (route === 'cancel' && ['pending', 'processing'].includes(snapshot(job).status)) job.canceledAt = now();
    return response(200, { snapshot: snapshot(job) });
  };
}
