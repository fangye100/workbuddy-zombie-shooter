import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function layerOf(file, rules) {
  if (rules.hostFiles?.includes(file)) return 'host';
  if (file.startsWith(rules.presentationRoot)) return 'game-presentation';
  const pkg = /^packages\/([^/]+)\//.exec(file)?.[1];
  if (pkg) return rules.frameworkPackages.includes(pkg) ? 'framework' : rules.gamePackages.includes(pkg) ? 'game-core' : null;
  if (file.startsWith('apps/editor/')) return 'editor';
  if (file.startsWith('apps/samples/')) return 'host';
  if (file.startsWith('assets/behaviors/')) return 'game-core';
  if (file.startsWith('assets/')) return 'game-data';
  if (file.startsWith('tools/')) return 'tool';
  return null;
}

/** Source-level dependency evidence, deliberately independent of inferred call counts. */
export function dependencies(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result = [];
  const add = (node, kind, typeOnly = false) => {
    if (ts.isStringLiteralLike(node)) result.push({ specifier: node.text, kind, typeOnly, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    else result.push({ specifier: null, kind, typeOnly, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const allType = clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(e => e.isTypeOnly));
      add(node.moduleSpecifier, 'import', !!allType);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) add(node.moduleReference.expression, 'import-equals', node.isTypeOnly);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, 'export', node.isTypeOnly);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, 'import-type', true);
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments[0]) add(node.arguments[0], node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require');
      } else if (node.expression.getText(source) === 'import.meta.glob' && node.arguments[0]) {
        const arg = node.arguments[0];
        if (ts.isArrayLiteralExpression(arg)) for (const a of arg.elements) add(a, 'glob');
        else add(arg, 'glob');
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if(node.expression.text === 'URL' && node.arguments?.[1]?.getText(source) === 'import.meta.url') add(node.arguments[0], 'url');
      else if(['Worker','SharedWorker'].includes(node.expression.text) && node.arguments?.[0] && !ts.isNewExpression(node.arguments[0])) add(node.arguments[0], 'worker');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

export function inspectEdge(file, edge, rules, exists) {
  const from = layerOf(file, rules), spec = edge.specifier;
  if (!from) return `Unclassified source: ${file}`;
  if (spec === null) return ['framework', 'game-core'].includes(from) ? 'Non-literal module dispatch requires an explicit host port' : null;
  if (spec.startsWith('/')) return 'Absolute project imports/globs/URLs must use relative paths or public aliases';
  if (spec.startsWith('!') && edge.kind === 'glob') return null;
  let target;
  if (spec.startsWith('@aether/')) {
    const match = /^@aether\/([^/]+)(?:\/(.+))?$/.exec(spec);
    if (!match) return `Invalid package alias: ${spec}`;
    const [, pkg, subpath] = match;
    if (subpath) {
      const name = /^presentation\/([a-z-]+)$/.exec(subpath)?.[1];
      if (pkg !== 'zombie-game' || !rules.publicGameSubpaths.includes(name)) return `Non-public package subpath: ${spec}`;
      target = `packages/${pkg}/src/${subpath}.ts`;
    } else target = `packages/${pkg}/src/index.ts`;
    if (!exists(target)) return `Missing package entry: ${target}`;
  } else if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec.split('?')[0]));
    if (edge.kind === 'glob') {
      const prefix = base.split(/[*{[]/)[0];
      target = prefix.endsWith('/') ? prefix + '__glob__' : prefix;
    } else {
      target = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, base.replace(/\.js$/, '.ts')].find(exists);
      // URL resources can be host-generated; ordinary imports must resolve.
      if (!target) return edge.kind === 'url' ? null : `Unresolved relative module: ${spec}`;
    }
  } else return null; // External dependencies are outside the project ownership graph.
  const to = layerOf(target, rules);
  if (!to) return ['framework', 'game-core', 'game-presentation'].includes(from) ? `Unclassified dependency: ${target}` : null;
  if (!rules.allowed[from]?.includes(to)) return `${from} -> ${to} is forbidden (${edge.typeOnly ? 'type' : 'runtime'} ${edge.kind}): ${target}`;
  const fromPkg = /^packages\/([^/]+)\//.exec(file)?.[1], toPkg = /^packages\/([^/]+)\//.exec(target)?.[1];
  if (fromPkg && toPkg && fromPkg !== toPkg && spec.startsWith('.')) return `Cross-package dependency must use a public @aether entry: ${target}`;
  return null;
}

const ignored = new Set(['node_modules', 'dist', '.workbuddy', '.code-graph', '.git', '_delivery', '__pycache__']);
export function sourceFiles(root, rules) {
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (ignored.has(item.name)) continue;
      const file = `${dir}/${item.name}`;
      if (item.isDirectory()) walk(file);
      else if (/\.(ts|mjs|js)$/.test(file) && !/\.d\.ts$/.test(file) && !/(^|\/)test(s)?\//.test(file) && !/\.(test|spec)\./.test(file)) files.push(file);
    }
  }
  for (const dir of rules.sourceRoots) walk(dir);
  return files.sort();
}

export function checkArchitecture(root, rules) {
  const errors = [], counts = {}, files = sourceFiles(root, rules);
  for (const file of files) {
    const layer = layerOf(file, rules);
    if (!layer) { errors.push(`${file}: Unclassified production source`); continue; }
    counts[layer] = (counts[layer] || 0) + 1;
    for (const edge of dependencies(file, fs.readFileSync(path.join(root, file), 'utf8'))) {
      const error = inspectEdge(file, edge, rules, f => fs.existsSync(path.join(root, f)));
      if (error) errors.push(`${file}:${edge.line}: ${error}`);
    }
  }
  return { files: files.length, counts, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const rules = JSON.parse(fs.readFileSync(new URL('./layers.json', import.meta.url), 'utf8'));
  const result = checkArchitecture(root, rules);
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
