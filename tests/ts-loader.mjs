import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    try {
      await access(candidate);
      return nextResolve(candidate.href, context);
    } catch {
      // Fall through to Node's normal resolution.
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.md')) {
    const source = await readFile(new URL(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
  }
  return nextLoad(url, context);
}
