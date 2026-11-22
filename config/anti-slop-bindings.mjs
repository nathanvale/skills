export const isReassigned = (variable) =>
  variable.references.some(
    (reference) => reference.isWrite() && !reference.init,
  );
