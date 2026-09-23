const unchanged = Symbol('unchanged-library');
export const unchangedLibrary = (value) => ({ [unchanged]: true, value });
export const serializeLibrary = (library) => JSON.stringify(library);

export const createDeduplicatedLibraryWriter = (write) => {
  let persisted = null;
  return async (library) => {
    const serialized = serializeLibrary(library);
    if (serialized === persisted) return false;
    await write(library, serialized);
    // Advance only after durable persistence. Failed writes remain retryable.
    persisted = serialized;
    return true;
  };
};

export async function persistLibraryUpdate(library, updater, write) {
  const result = await updater(library);
  // Opt-in only: returning false/null alone does not imply there was no change.
  if (result?.[unchanged] === true) return result.value;
  await write(library);
  return result;
}
