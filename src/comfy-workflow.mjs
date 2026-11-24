import { civitaiAir } from './catalog.mjs';

const savedOutputs = new Set(['SaveImage', 'SaveImageAdvanced', 'SaveAnimatedPNG', 'SaveAnimatedWEBP', 'SaveSVGNode',
  'SaveVideo', 'SaveWEBM', 'SaveAudio', 'SaveAudioMP3', 'SaveAudioOpus', 'SaveGLB', 'SaveLatent',
  'CCollins_CiviScribe_SaveImage', 'VHS_VideoCombine']);
const previewOutputs = new Set(['PreviewImage', 'PreviewAny', 'PreviewAudio', 'PreviewVideo', 'Preview3D', 'PreviewLatent']);
const primitiveTypes = new Set(['PrimitiveBoolean', 'PrimitiveInt', 'PrimitiveString', 'PrimitiveStringMultiline', 'PrimitiveNode']);
const routedTypes = new Set(['ComfySwitchNode', 'ImpactSwitch', 'LazySwitchKJ', 'Any Switch (rgthree)', 'Context Switch (rgthree)']);
const basicPipeFields = ['model', 'clip', 'vae', 'positive', 'negative'];
const basicPipeOutputOffset = new Map([['FromBasicPipe', 0], ['FromBasicPipe_v2', 1]]);
const maximumNodes = 10_000;
const maximumLinks = 50_000;
const maximumScopes = 256;
const maximumSlots = 512;
const maximumPath = 64;
const muted = 2;
const bypass = 4;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const nodeId = value => (Number.isSafeInteger(value) || typeof value === 'string' && /^[\w.:-]{1,120}$/u.test(value)) ? String(value) : null;
const slotNumber = value => Number.isSafeInteger(value) && value >= 0 && value < maximumSlots;
const unresolved = Object.freeze({ unresolved: true });

export function selectorAir(value, mapping, slot) {
  if (typeof mapping === 'string' && mapping.length <= 100_000) {
    try { mapping = JSON.parse(mapping); } catch { mapping = null; }
  }
  const slots = record(mapping?.bySlot) ? mapping.bySlot : mapping;
  const selected = record(slots) && Object.hasOwn(slots, String(slot)) ? slots[String(slot)] : value;
  const parsed = civitaiAir(selected);
  return parsed?.kind === 'version' ? parsed.air : null;
}

function canvasLink(raw) {
  const [link, origin, output, target, input, type] = Array.isArray(raw) ? raw : [raw?.id, raw?.origin_id,
    raw?.origin_slot, raw?.target_id, raw?.target_slot, raw?.type];
  const edge = { link: nodeId(link), origin: nodeId(origin), output, target: nodeId(target), input, type };
  return edge.origin && edge.target && slotNumber(input) && slotNumber(output) ? edge : null;
}

function graphTemplate(data, canvas) {
  const nodes = new Map();
  const inputs = new Map();
  if (canvas && data.nodes.length > maximumNodes) throw new Error('This workflow has too many nodes to check in the browser.');
  const rows = canvas ? array(data.nodes).map((raw, index) => [nodeId(raw?.id) ?? '@' + index, raw]) : Object.entries(data);
  if (rows.length > maximumNodes) throw new Error('This workflow has too many nodes to check in the browser.');
  for (const [id, raw] of rows) {
    const type = canvas ? raw?.type : raw?.class_type;
    if (typeof type !== 'string' || !type || type.length > 240 || !canvas && !nodeId(id)) continue;
    if (nodes.has(id)) throw new Error('This workflow repeats a node ID.');
    nodes.set(id, { id, type, mode: raw.mode, raw, slots: canvas ? array(raw.inputs).slice(0, maximumSlots) : [] });
  }
  const links = array(data.links);
  if (links.length > maximumLinks) throw new Error('This workflow has too many links to check in the browser.');
  if (canvas) for (const raw of links) {
    const edge = canvasLink(raw);
    if (!edge) continue;
    if (!inputs.has(edge.target)) inputs.set(edge.target, new Map());
    const slots = inputs.get(edge.target);
    slots.set(edge.input, slots.has(edge.input) ? unresolved : edge);
  }
  return { canvas, data, nodes, inputs, inputId: nodeId(data.inputNode?.id), outputId: nodeId(data.outputNode?.id) };
}

function canvasState(main) {
  const definitions = [main];
  const byType = new Map();
  let declaredNodes = main.nodes.size;
  let declaredLinks = array(main.data.links).length;
  for (let index = 0; index < definitions.length; index++) {
    for (const definition of array(definitions[index].data.definitions?.subgraphs)) {
      if (!Array.isArray(definition?.nodes)) continue;
      if (definitions.length >= maximumScopes) throw new Error('This workflow has too many subgraph definitions to check in the browser.');
      const id = typeof definition.id === 'string' ? nodeId(definition.id) : null;
      if (id && byType.has(id)) throw new Error('This workflow repeats a subgraph definition ID.');
      const template = graphTemplate(definition, true);
      declaredNodes += template.nodes.size;
      declaredLinks += array(definition.links).length;
      if (declaredNodes > maximumNodes || declaredLinks > maximumLinks) throw new Error('This workflow exceeds the browser graph limit.');
      if (id) byType.set(id, template);
      definitions.push(template);
    }
  }
  const scopes = [{ id: 0, template: main, children: new Map() }];
  let instanceNodes = main.nodes.size;
  for (let index = 0; index < scopes.length; index++) {
    const scope = scopes[index];
    for (const node of scope.template.nodes.values()) {
      const template = byType.get(node.type);
      if (!template || node.mode === muted || node.mode === bypass) continue;
      let ancestor = scope;
      while (ancestor && ancestor.template !== template) ancestor = ancestor.parent;
      if (ancestor) {
        scope.children.set(node.id, null);
        continue;
      }
      instanceNodes += template.nodes.size;
      if (scopes.length >= maximumScopes || instanceNodes > maximumNodes) throw new Error('This workflow has too many subgraph instances to check in the browser.');
      const child = { id: scopes.length, template, parent: scope, host: node, children: new Map() };
      scope.children.set(node.id, child);
      scopes.push(child);
    }
  }
  return { definitions, scopes, declaredNodes };
}

function fields(scope, node) {
  if (!scope.template.canvas) return Object.keys(node.raw.inputs ?? {}).slice(0, maximumSlots);
  const links = scope.template.inputs.get(node.id);
  return new Set([...Array.from(node.slots.keys()), ...(links?.keys() ?? [])]);
}

function widget(node, name, index) {
  const values = node.raw.widgets_values;
  return Array.isArray(values) ? values[index] : record(values) && Object.hasOwn(values, name) ? values[name] : undefined;
}

function input(scope, node, name, index) {
  if (scope.template.canvas) {
    const slot = typeof name === 'number' ? name : node.slots.findIndex(row => row?.name === name);
    const port = node.slots[slot];
    const edge = scope.template.inputs.get(node.id)?.get(slot);
    if (edge || port?.link != null) {
      if (!edge || edge.unresolved || port?.link != null && edge.link !== nodeId(port.link)) return unresolved;
      return { edge, type: port?.type ?? edge.type };
    }
    return { value: widget(node, typeof name === 'number' ? port?.widget?.name ?? port?.name : name, index) };
  }
  const values = node.raw.inputs;
  const value = record(values) && Object.hasOwn(values, name) ? values[name] : undefined;
  if (Array.isArray(value) && value.length === 2 && nodeId(value[0]) && slotNumber(value[1])) {
    return { edge: { origin: nodeId(value[0]), output: value[1] } };
  }
  return { value };
}

function boundaryInput(scope, edge) {
  const exposed = scope.template.data.inputs?.[edge.output];
  const name = exposed?.name;
  const host = scope.host;
  const slot = typeof name === 'string' ? host.slots.findIndex(port => port?.name === name) : edge.output;
  const bound = input(scope.parent, host, slot, undefined);
  if (bound.edge || bound.unresolved) return bound;
  const target = scope.template.nodes.get(edge.target);
  const widgetName = target?.slots[edge.input]?.widget?.name ?? target?.slots[edge.input]?.name ?? name;
  const proxies = array(host.raw.properties?.proxyWidgets).slice(0, maximumSlots);
  const index = proxies.findIndex(row => Array.isArray(row) && nodeId(row[0]) === edge.target && row[1] === widgetName);
  const value = widget(host, name, index);
  return value === undefined ? { defaultWidget: true } : { value };
}

const connectionTypes = value => String(value ?? '').split(',').map(type => type.toLowerCase().trim());
function matchesType(first, second) {
  const wanted = connectionTypes(second);
  return connectionTypes(first).some(type => !type || type === '*' || wanted.includes('*') || wanted.includes('') || wanted.includes(type));
}

function bypassInput(scope, node, slot, type) {
  if (!scope.template.canvas) return unresolved;
  const ownType = node.raw.outputs?.[slot]?.type;
  if (ownType == null || type == null) return unresolved;
  const same = port => port && matchesType(port.type, ownType) && matchesType(port.type, type);
  const exact = node.slots.findIndex(port => port?.type === type);
  const selected = type === '*' || type === '' ? node.slots[slot] ? slot : 0
    : same(node.slots[slot]) ? slot : exact >= 0 ? exact : node.slots.findIndex(same);
  const value = input(scope, node, selected);
  return value.edge ? value : unresolved;
}

function readValue(scope, node, name, position, visited = new Set()) {
  const field = input(scope, node, name, position);
  if (!field.edge) return field;
  const linked = resolveWire(scope, field, visited);
  if (linked.defaultWidget) return { value: widget(node, name, position) };
  if (!linked.node) return linked;
  const source = linked.node;
  if (primitiveTypes.has(source.type) && linked.slot === 0) {
    return readValue(linked.scope, source, 'value', 0, visited);
  }
  if (source.type === 'CivitaiModelSelector') return { value: airAt(linked.scope, source, linked.slot) };
  return { unresolved: true, valueUnknown: true };
}

function airAt(scope, node, slot) {
  const values = node.raw.inputs;
  const props = node.raw.properties;
  // The API prompt has named selector fields. Canvas exports can carry the same named widget values.
  return selectorAir(scope.template.canvas ? widget(node, 'air') ?? props?.air : values?.air,
    scope.template.canvas ? widget(node, 'resources_json') ?? props?.resources_json : values?.resources_json, slot);
}

function resolveWire(scope, field, visited = new Set(), pipeField) {
  while (field.edge) {
    const edge = field.edge;
    const key = [scope.id, edge.origin, edge.output, pipeField, String(field.type ?? '').slice(0, 80)].join('/');
    if (visited.has(key) || visited.size >= maximumPath) return unresolved;
    visited.add(key);
    if (scope.parent && edge.origin === scope.template.inputId) {
      field = boundaryInput(scope, edge);
      scope = scope.parent;
      continue;
    }
    const node = scope.template.nodes.get(edge.origin);
    if (!node || node.mode === muted) return unresolved;
    if (node.mode === bypass) { field = bypassInput(scope, node, edge.output, field.type); continue; }
    if (scope.children.has(node.id)) {
      const child = scope.children.get(node.id);
      const jump = child?.template.inputs.get(child.template.outputId)?.get(edge.output);
      if (!jump || jump.unresolved) return unresolved;
      scope = child;
      field = { edge: jump, type: field.type ?? jump.type };
      continue;
    }
    if (node.type === 'Reroute') { field = input(scope, node, scope.template.canvas ? 0 : 'input'); continue; }
    if (node.type === 'ComfySwitchNode') {
      const { value } = readValue(scope, node, 'switch', 0, new Set(visited));
      if (typeof value !== 'boolean') return unresolved;
      field = input(scope, node, value ? 'on_true' : 'on_false');
      continue;
    }
    if (routedTypes.has(node.type)) return unresolved;
    const offset = basicPipeOutputOffset.get(node.type);
    if (offset !== undefined) {
      if (edge.output >= offset) {
        if (pipeField) return unresolved;
        pipeField = basicPipeFields[edge.output - offset];
        if (!pipeField) return unresolved;
      }
      field = input(scope, node, 'basic_pipe');
      if (!field.edge) return unresolved;
      continue;
    }
    if (pipeField && edge.output === 0 && node.type === 'ToBasicPipe') {
      field = input(scope, node, pipeField);
      if (!field.edge) return unresolved;
      pipeField = undefined;
      continue;
    }
    if (pipeField && edge.output === 0 && node.type === 'EditBasicPipe') {
      const override = input(scope, node, pipeField);
      if (override.unresolved || override.value != null) return unresolved;
      if (override.edge) {
        const selected = resolveWire(scope, override, new Set(visited));
        if (selected.node) return selected;
        if (!selected.defaultWidget && selected.value !== null) return unresolved;
      }
      field = input(scope, node, 'basic_pipe');
      if (!field.edge) return unresolved;
      continue;
    }
    return { scope, node, slot: edge.output, ...(pipeField && unresolved) };
  }
  return pipeField ? unresolved : field;
}

function upstreamInputs(scope, node, slot) {
  if (node.type === 'EditBasicPipe' && slot === 0) {
    const pipe = { edge: { origin: node.id, output: slot } };
    return basicPipeFields.map(name => resolveWire(scope, pipe, new Set(), name));
  }
  return [...fields(scope, node)].map(name => resolveWire(scope, input(scope, node, name)));
}

function graphContents(data) {
  const api = record(data.prompt) ? data.prompt : data;
  if (Object.values(api).some(node => typeof node?.class_type === 'string')) {
    const template = graphTemplate(api, false);
    return { definitions: [template], scopes: [{ id: 0, template, children: new Map() }], declaredNodes: template.nodes.size };
  }
  const canvas = Array.isArray(data.nodes) ? data : data.workflow;
  if (!Array.isArray(canvas?.nodes)) throw new Error('Choose a ComfyUI workflow or API JSON file.');
  return canvasState(graphTemplate(canvas, true));
}

export function traceComfyWorkflow(data) {
  if (!record(data)) throw new Error('Choose a ComfyUI workflow or API JSON file.');
  const { definitions, scopes, declaredNodes } = graphContents(data);
  const inventory = definitions.flatMap(template => [...template.nodes.values()].map(node => ({ node, template })));
  const roots = [];
  for (const scope of scopes) for (const node of scope.template.nodes.values()) {
    if (savedOutputs.has(node.type)) roots.push({ scope, node, save: true });
    else if (previewOutputs.has(node.type)) roots.push({ scope, node, save: false });
  }
  const partial = !scopes[0].template.canvas && Array.isArray(data.partial_execution_targets);
  const selectedIds = new Set(partial ? data.partial_execution_targets.slice(0, maximumNodes).map(nodeId).filter(Boolean) : []);
  const eligible = roots.filter(({ node }) => node.mode !== muted && node.mode !== bypass);
  const selected = partial ? eligible.filter(({ node }) => selectedIds.has(node.id))
    : eligible.some(item => item.save) ? eligible.filter(item => item.save) : eligible;
  const mode = selected.length ? partial ? 'selected' : selected[0].save ? 'saved' : 'preview'
    : partial || roots.length ? 'disabled' : 'inventory';
  const reached = new Map();
  const pending = [...selected];
  let uncertain = partial ? selectedIds.size - selected.length : 0;
  for (let index = 0; index < pending.length; index++) {
    const { scope, node, slot } = pending[index];
    const key = scope.id + '/' + node.id;
    if (reached.has(key)) {
      if (slot != null) reached.get(key).add(slot);
      continue;
    }
    reached.set(key, new Set(slot == null ? [] : [slot]));
    for (const linked of upstreamInputs(scope, node, slot)) {
      if (linked.unresolved) uncertain++;
      if (linked.node) pending.push(linked);
    }
    if (pending.length > maximumLinks) throw new Error('This workflow has too many active links to check in the browser.');
  }
  const active = [];
  for (const scope of scopes) for (const node of scope.template.nodes.values()) {
    const slots = reached.get(scope.id + '/' + node.id);
    if (!slots) continue;
    active.push({ node, slots, canvas: scope.template.canvas,
      read: (name, index) => readValue(scope, node, name, index),
      air: slot => airAt(scope, node, slot),
    });
  }
  return { nodeCount: declaredNodes, inventory, active, mode, outputs: selected.length, uncertain };
}
