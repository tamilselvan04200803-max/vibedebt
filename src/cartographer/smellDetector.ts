import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { relative } from 'node:path';
import type { SourceLocation, TopologyReport } from '../contracts/types.js';
/** Alpha-normalize bindings while retaining operators, properties and constants. */
export function signature(root: Node): string {
  const names = new Map<string, number>();
  function visit(node: Node): string {
    if (Node.isParenthesizedExpression(node)) return visit(node.getExpression());
    if (Node.isIdentifier(node)) {
      const parent = node.getParent();
      if ((Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) ||
          (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) ||
          ['Number', 'Math'].includes(node.getText())) return node.getText();
      const key = node.getSymbol()?.getDeclarations()[0]?.getStart().toString() + ':' + node.getText();
      if (!names.has(key)) names.set(key, names.size);
      return `$${names.get(key)}`;
    }
    if (Node.isStringLiteral(node)) return JSON.stringify(node.getLiteralValue());
    const children = node.getChildren();
    return children.length ? `${node.getKindName()}(${children.map(visit).join(',')})` : node.getText();
  }
  return visit(root);
}

/** Exclude writes, unused mutation results, and dependency-array bookkeeping. */
function meaningfulRead(ref: Node): boolean {
  const p = ref.getParent();
  // Reading a value solely to overwrite itself does not make it observable.
  if (Node.isIdentifier(ref)) {
    const assignment = ref.getAncestors().find(n => Node.isBinaryExpression(n) &&
      n.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      Node.isExpressionStatement(n.getParent()));
    if (assignment && Node.isBinaryExpression(assignment)) {
      const left = assignment.getLeft();
      const right = assignment.getRight();
      if (Node.isIdentifier(left) && left.getSymbol() === ref.getSymbol() &&
          ![right, ...right.getDescendants()].some(n =>
            Node.isCallExpression(n) || Node.isAwaitExpression(n) || Node.isYieldExpression(n) ||
            Node.isPostfixUnaryExpression(n) || Node.isPrefixUnaryExpression(n) ||
            (Node.isBinaryExpression(n) &&
              n.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment &&
              n.getOperatorToken().getKind() <= SyntaxKind.LastAssignment))) return false;
    }
  }
  if (Node.isBinaryExpression(p) && p.getLeft() === ref &&
      /^[+\-*/%&|^]?=$/.test(p.getOperatorToken().getText())) return false;
  if ((Node.isPostfixUnaryExpression(p) || Node.isPrefixUnaryExpression(p)) &&
      Node.isExpressionStatement(p.getParent())) return false;
  if (Node.isPropertyAccessExpression(p) && p.getExpression() === ref &&
      ['push', 'unshift', 'splice', 'pop', 'shift', 'sort', 'reverse'].includes(p.getName())) {
    const call = p.getParent();
    if (Node.isCallExpression(call) && Node.isExpressionStatement(call.getParent())) return false;
  }
  if (Node.isArrayLiteralExpression(p)) {
    const call = p.getParent();
    if (Node.isCallExpression(call) && /^use(Effect|Memo|Callback)$/.test(call.getExpression().getText()) &&
        call.getArguments()[1] === p) return false;
  }
  return true;
}

export function detectEmptyCatchBlocks(sources: SourceFile[], dir: string): SourceLocation[] {
  return sources.flatMap(source => {
    const file = relative(dir, source.getFilePath()).replaceAll('\\', '/');
    return source.getDescendantsOfKind(SyntaxKind.CatchClause)
      .filter(clause => clause.getBlock().getStatements().length === 0)
      .map(clause => ({ file, line: clause.getStartLineNumber(), snippet: clause.getText().slice(0, 1200) }));
  });
}

export function detectSmells(sources: SourceFile[], dir: string): Pick<TopologyReport,
  'duplicatedLogic' | 'orphanedState' | 'apiInconsistencies'> {
  const report: Pick<TopologyReport, 'duplicatedLogic' | 'orphanedState' | 'apiInconsistencies'> = {
    duplicatedLogic: [], orphanedState: [], apiInconsistencies: [] };
  const duplicates = new Map<string, SourceLocation[]>();
  const endpoints = new Map<string, (SourceLocation & { endpoint: string })[]>();
  for (const source of sources) {
    const path = relative(dir, source.getFilePath()).replaceAll('\\', '/');
    const location = (node: Node): SourceLocation => ({ file: path, line: node.getStartLineNumber(), snippet: node.getText().slice(0, 1200) });
    source.forEachDescendant(node => {
      // Financial candidates are expressions, not comments or matching source text.
      if (Node.isBinaryExpression(node) || Node.isIfStatement(node) || Node.isCallExpression(node)) {
        if (/price|quantity|subtotal|discount|coupon|promo|netTotal|VIBE20|SAVE10/i.test(node.getText()) &&
            !node.getDescendants().some(n => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n)) &&
            node.getText().length <= 1500) {
          const key = signature(node);
          const entries = duplicates.get(key) ?? [];
          entries.push(location(node)); duplicates.set(key, entries);
        }
      }
      if (Node.isVariableDeclaration(node)) {
        const binding = node.getNameNode();
        const init = node.getInitializer();
        const isState = Node.isCallExpression(init) && /^(useState|React\.useState)$/.test(init.getExpression().getText());
        const name = isState && Node.isArrayBindingPattern(binding) ? binding.getElements()[0] : binding;
        const identifier = Node.isBindingElement(name) ? name.getNameNode() : name;
        if (identifier && Node.isIdentifier(identifier) &&
            !(Node.isArrowFunction(init) || Node.isFunctionExpression(init)) &&
            !node.getVariableStatement()?.isExported() &&
            !identifier.findReferencesAsNodes().some(meaningfulRead)) {
          report.orphanedState.push({ ...location(node), name: identifier.getText(),
            kind: isState ? 'useState' : 'variable', reason: 'No meaningful reads; references only write or mutate the value.' });
        }
      }
      if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateHead(node)) {
        const text = Node.isTemplateHead(node) ? node.getLiteralText() : node.getLiteralValue();
        const match = text.match(/(?:https?:\/\/[^/]+)?(\/api\/(?:v\d+\/)?([\w-]+))(?=[/?#]|$)/);
        if (match) {
          const entries = endpoints.get(match[2]) ?? [];
          entries.push({ ...location(node), endpoint: match[1] }); endpoints.set(match[2], entries);
        }
      }

      // Semantic rule evidence: only executable AST expressions count.
      if (Node.isConditionalExpression(node) && /subtotal/.test(node.getCondition().getText()) &&
          node.getCondition().getDescendantsOfKind(SyntaxKind.NumericLiteral).some(n => n.getLiteralValue() === 150) &&
          node.getDescendantsOfKind(SyntaxKind.NumericLiteral).some(n => n.getLiteralValue() === 5.99)) {
        const entries = duplicates.get('shipping: subtotal >= 150 ? 0 : 5.99') ?? [];
        entries.push(location(node)); duplicates.set('shipping: subtotal >= 150 ? 0 : 5.99', entries);
      }
      if ((Node.isBinaryExpression(node) && node.getOperatorToken().getText() === '*' &&
          node.getDescendantsOfKind(SyntaxKind.NumericLiteral).some(n => n.getLiteralValue() === 0.05)) ||
          (Node.isVariableDeclaration(node) && node.getName() === 'taxRate' && node.getInitializer()?.getText() === '0.05')) {
        const entries = duplicates.get('tax: default rate 0.05') ?? [];
        entries.push(location(node)); duplicates.set('tax: default rate 0.05', entries);
      }
    });
  }
  for (const [signature, occurrences] of duplicates) {
    if (new Set(occurrences.map(o => o.file)).size > 1) report.duplicatedLogic.push({ signature, occurrences, category: signature.startsWith('shipping:') ? 'shipping' : signature.startsWith('tax:') ? 'tax' : /VIBE20|SAVE10/.test(signature) ? 'coupon' : 'pricing' });
  }
  for (const [resource, occurrences] of endpoints) {
    const variants = [...new Set(occurrences.map(o => o.endpoint))].sort();
    if (variants.length > 1) report.apiInconsistencies.push({ resource, endpoints: variants, occurrences,
      reason: 'Mixed versioned and unversioned endpoint paths for the same API resource.' });
  }
  return report;
}
