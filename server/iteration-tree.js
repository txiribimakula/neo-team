// Read one level at a time: no fixed depth or result cap hides old iterations.
export async function readIterationTree(project, get) {
  const iterations = [];
  async function visit(segments, supplied) {
    const node = supplied ?? await get(segments);
    if (!node) throw new Error('No se pudo leer el árbol completo de iteraciones.');
    if (segments.length) iterations.push({ id: node.identifier, name: node.name,
      path: [project, ...segments].join('\\'), attributes: node.attributes ?? {} });
    let children = node.children;
    if (node.hasChildren && !children?.length) {
      const expanded = await get(segments);
      children = expanded?.children;
      if (!children?.length) throw new Error('Azure no devolvió todas las iteraciones. Actualiza de nuevo.');
    }
    for (const child of children ?? []) await visit([...segments, child.name], child.hasChildren ? undefined : child);
  }
  await visit([]);
  return iterations;
}
