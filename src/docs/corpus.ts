import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export type RouterOsVersion = 6 | 7;

export interface DocSection {
  /** File the section came from, without extension. */
  doc: string;
  /** Title of the containing document. */
  docTitle: string;
  /** The section's own heading. */
  heading: string;
  /** RouterOS versions the section applies to. */
  versions: RouterOsVersion[];
  tags: string[];
  body: string;
}

/**
 * The docs directory, which sits at the package root beside `dist`.
 *
 * `src/docs/corpus.ts` and `dist/docs/corpus.js` are both two levels deep, so
 * the same relative path works when running from source and when running the
 * published package.
 */
export function docsDirectory(): string {
  return fileURLToPath(new URL("../../docs/", import.meta.url));
}

interface FrontMatter {
  title: string;
  versions: RouterOsVersion[];
  tags: string[];
  body: string;
}

function parseFrontMatter(text: string, fallbackTitle: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { title: fallbackTitle, versions: [6, 7], tags: [], body: text };

  const head = match[1] ?? "";
  const body = text.slice(match[0].length);

  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:\\s*(.+)$`, "m").exec(head)?.[1]?.trim();

  const list = (raw: string | undefined): string[] =>
    raw
      ? raw
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : [];

  const versions = list(field("versions"))
    .map((v) => Number(v))
    .filter((v): v is RouterOsVersion => v === 6 || v === 7);

  return {
    title: field("title") ?? fallbackTitle,
    versions: versions.length ? versions : [6, 7],
    tags: list(field("tags")),
    body,
  };
}

/**
 * A heading may narrow the versions it applies to by ending in a marker:
 * "### BGP (v7)" or "### OSPF (v6, v7)".
 */
function versionsFromHeading(
  heading: string,
  inherited: RouterOsVersion[],
): { heading: string; versions: RouterOsVersion[] } {
  const match = /\s*\((v\d(?:\s*,\s*v\d)*)\)\s*$/i.exec(heading);
  if (!match) return { heading, versions: inherited };

  const versions = (match[1] ?? "")
    .split(",")
    .map((v) => Number(v.trim().replace(/^v/i, "")))
    .filter((v): v is RouterOsVersion => v === 6 || v === 7);

  return {
    heading: heading.slice(0, match.index).trim(),
    versions: versions.length ? versions : inherited,
  };
}

/** Split one markdown document into its `##` / `###` sections. */
export function parseDocument(name: string, text: string): DocSection[] {
  const { title, versions, tags, body } = parseFrontMatter(text, name);
  const sections: DocSection[] = [];

  let heading = "";
  let headingVersions = versions;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (heading && content) {
      sections.push({
        doc: name,
        docTitle: title,
        heading,
        versions: headingVersions,
        tags,
        body: content,
      });
    }
    buffer = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const resolved = versionsFromHeading(match[2] ?? "", versions);
      heading = resolved.heading;
      headingVersions = resolved.versions;
    } else {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Read and parse every document.
 *
 * Nothing is cached: the corpus is small, and re-reading keeps the server
 * stateless and picks up edits without a restart, like the config does.
 */
export function loadCorpus(directory: string = docsDirectory()): DocSection[] {
  let files: string[];
  try {
    files = readdirSync(directory).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  return files
    .sort()
    .flatMap((file) =>
      parseDocument(file.replace(/\.md$/, ""), readFileSync(join(directory, file), "utf8")),
    );
}
