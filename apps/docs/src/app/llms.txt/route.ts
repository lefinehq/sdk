import { source } from '@/lib/source';
import { generateVersionHeader } from '@/lib/get-versions';
import type * as PageTree from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';

export const revalidate = false;

// fumadocs' own page-tree types: the tree `source` hands us, not a copy that drifts from it.
type PageTreeItem = PageTree.Item;
type PageTreeNode = PageTree.Node;

function urlToMdxPath(url: string): string {
  if (url === '/') return '/index.mdx';

  // Remove trailing slash
  const clean = url.replace(/\/$/, '');
  return `${clean}.mdx`;
}

function nodeToString(node: ReactNode): string {
  if (node == null) return '';
  return String(node);
}

function renderItem(item: PageTreeItem): string {
  const title = nodeToString(item.name);
  const mdxPath = urlToMdxPath(item.url);
  const desc = nodeToString(item.description);

  if (desc) {
    return `- [${title}](${mdxPath}): ${desc}`;
  }
  return `- [${title}](${mdxPath})`;
}

function renderTree(nodes: PageTreeNode[], isTopLevel = false): string {
  const lines: string[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'page':
        lines.push(renderItem(node));
        break;
      case 'separator': {
        const name = nodeToString(node.name);
        if (name) {
          lines.push('');
          lines.push(`### ${name}`);
        }
        break;
      }
      case 'folder': {
        // All top-level folders and root folders get ## headings
        if (node.root || isTopLevel) {
          lines.push('');
          lines.push(`## ${nodeToString(node.name)}`);
        }

        // Render index page if present
        if (node.index) {
          lines.push(renderItem(node.index));
        }

        // Recurse into children
        const childContent = renderTree(node.children);
        if (childContent) {
          lines.push(childContent);
        }
        break;
      }
    }
  }

  return lines.join('\n');
}

export async function GET() {
  const versionHeader = await generateVersionHeader();
  const tree = source.getPageTree();

  const intro = `# Lefine

> AI-powered localization platform for engineering teams — CDN-first delivery with optional GitHub workflows.

## Docs
- [llms.txt](/llms.txt): Table of contents with links to individual pages
- [llms-full.txt](/llms-full.txt): Complete documentation in a single file

## Table of Contents
`;

  const toc = renderTree(tree.children, true);

  return new Response(`${versionHeader}${intro}${toc}\n`);
}
