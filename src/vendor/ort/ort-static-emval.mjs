// Emscripten Emval's four invoke kinds and 8-byte wasm32 argument slots.
// The caller supplies already registered wire-type readers from the pinned runtime.
const execute = [
  (resolve, _, handle, _method, read) => Reflect.apply(resolve(handle), undefined, read()),
  (resolve, name, handle, method, read) => {
    const receiver = resolve(handle);
    const member = receiver[name(method)];
    return Reflect.apply(member, receiver, read());
  },
  (resolve, _, handle, _method, read) => Reflect.construct(resolve(handle), read()),
  (_resolve, _name, _handle, _method, read) => read()[0],
];

export function createStaticEmvalInvoker(kind, readers, resolve, name, toWire, finishReturn) {
  const invoke = execute[kind];
  if (!Number.isInteger(kind) || typeof invoke !== 'function' || kind === 3 && readers.length !== 1) {
    throw new RangeError('Unexpected Emscripten method caller signature.');
  }
  return function staticInvoker(handle, methodName, destructorsRef, argsPointer) {
    const read = () => readers.map((fromPointer, index) => fromPointer(argsPointer + 8 * index));
    const value = invoke(resolve, name, handle, methodName, read);
    return toWire ? finishReturn(toWire, destructorsRef, value) : undefined;
  };
}
