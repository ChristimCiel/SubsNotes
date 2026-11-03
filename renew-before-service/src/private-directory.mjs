import { access, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const contains = (root, path) => {
  const part = relative(root, path);
  return part === '' || !(part === '..' || part.startsWith('..' + sep) || isAbsolute(part));
};

// Resolve existing ancestors as well as the final directory, without creating it.
async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

export async function assertPrivateDirectory(directory, { sourceDirectory = resolve(import.meta.dirname, '..') } = {}) {
  const requestedSource = resolve(sourceDirectory);
  const source = await realpath(requestedSource);
  const roots = new Set([source, requestedSource]);
  const protect = root => {
    roots.add(root);
    // Preserve the caller's spelling too (for example /var versus /private/var).
    roots.add(resolve(requestedSource, relative(source, root)));
  };
  for (let ancestor = source; ; ancestor = dirname(ancestor)) {
    // .git can be a directory or a worktree pointer file.
    try { await access(join(ancestor, '.git')); protect(ancestor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Source archives do not contain .git, but retain the publication root.
    try {
      const manifest = JSON.parse(await readFile(join(ancestor, 'package.json'), 'utf8'));
      if (manifest.name === 'subsnotes') protect(ancestor);
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (dirname(ancestor) === ancestor) break;
  }
  const requested = resolve(directory);
  const target = await canonicalPath(requested);
  if ([...roots].some(root => contains(root, requested) || contains(root, target))) {
    throw new Error('Private mail must be stored outside the source repository');
  }
  return target;
}
