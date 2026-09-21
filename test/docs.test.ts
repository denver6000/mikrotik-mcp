import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadCorpus, parseDocument } from "../src/docs/corpus.ts";
import { searchDocs, tokenize } from "../src/docs/search.ts";
import { createServer } from "../src/server.ts";
import { sandbox } from "./helpers.ts";

const corpus = loadCorpus();

describe("corpus parsing", () => {
  it("loads the shipped documents", () => {
    assert.ok(corpus.length >= 10, `expected a populated corpus, got ${corpus.length} sections`);
    const docs = new Set(corpus.map((s) => s.doc));
    for (const expected of ["console", "reading-state", "v6-vs-v7", "making-changes"]) {
      assert.ok(docs.has(expected), `missing document: ${expected}`);
    }
  });

  it("reads front matter and splits on headings", () => {
    const sections = parseDocument(
      "sample",
      [
        "---",
        "title: Sample doc",
        "versions: [7]",
        "tags: [alpha, beta]",
        "---",
        "",
        "## First",
        "body one",
        "",
        "### Second",
        "body two",
      ].join("\n"),
    );

    assert.equal(sections.length, 2);
    assert.equal(sections[0]?.docTitle, "Sample doc");
    assert.deepEqual(sections[0]?.versions, [7]);
    assert.deepEqual(sections[0]?.tags, ["alpha", "beta"]);
    assert.equal(sections[0]?.heading, "First");
    assert.equal(sections[0]?.body, "body one");
    assert.equal(sections[1]?.heading, "Second");
  });

  it("lets a heading narrow the versions it applies to", () => {
    const sections = parseDocument(
      "sample",
      ["---", "title: T", "versions: [6, 7]", "---", "", "## BGP (v7)", "x", "", "## Shared", "y"].join(
        "\n",
      ),
    );
    assert.equal(sections[0]?.heading, "BGP", "the marker is stripped from the heading");
    assert.deepEqual(sections[0]?.versions, [7]);
    assert.deepEqual(sections[1]?.versions, [6, 7], "other sections inherit the document's versions");
  });

  it("defaults to both versions when front matter is absent", () => {
    const sections = parseDocument("sample", "## Heading\nbody");
    assert.deepEqual(sections[0]?.versions, [6, 7]);
  });

  it("every section has a heading and a body", () => {
    for (const section of corpus) {
      assert.ok(section.heading.trim(), `empty heading in ${section.doc}`);
      assert.ok(section.body.trim(), `empty body in ${section.doc} / ${section.heading}`);
    }
  });
});

describe("tokenizer", () => {
  it("splits command paths into segments", () => {
    assert.deepEqual(tokenize("/ip/firewall/filter"), ["ip", "firewall", "filter"]);
  });

  it("indexes hyphenated words whole and in parts", () => {
    const tokens = tokenize("address-list");
    assert.ok(tokens.includes("address-list"));
    assert.ok(tokens.includes("address"));
    assert.ok(tokens.includes("list"));
  });
});

describe("search ranking", () => {
  const top = (query: string, version?: 6 | 7) =>
    searchDocs(corpus, query, version ? { version } : {})[0]?.section;

  it("finds the numbering trap, which is the one an agent most needs", () => {
    const hit = top("remove firewall rule by number safely");
    assert.ok(hit, "expected a result");
    assert.match(`${hit.heading} ${hit.body}`, /find|number/i);
  });

  it("answers version-specific questions from the right section", () => {
    const hit = top("bgp peer configuration");
    assert.ok(hit);
    assert.match(hit.body + hit.heading, /bgp/i);
  });

  it("finds reading commands", () => {
    const hit = top("show dhcp leases");
    assert.ok(hit);
    assert.match(hit.body, /dhcp-server lease/);
  });

  it("filters by version", () => {
    for (const hit of searchDocs(corpus, "wireless wifi interface", { version: 6, limit: 10 })) {
      assert.ok(hit.section.versions.includes(6), `${hit.section.heading} is not a v6 section`);
    }
  });

  it("returns nothing for a query with no matching terms", () => {
    assert.deepEqual(searchDocs(corpus, "kubernetes ingress helm"), []);
  });

  it("ranks by section content, not by which document matched", () => {
    // Regression: per-document tags used to be folded into the scored text,
    // which made every section of a matching document score alike and let
    // BM25 length normalisation hand the win to the shortest one.
    const hit = top("how do I remove a firewall rule safely");
    assert.ok(hit);
    assert.match(hit.heading, /number|predicate/i, `ranked '${hit.heading}' first`);
    assert.match(hit.body, /\[find/, "the winning section should show the find idiom");
  });

  it("puts the version-differences BGP section first for a BGP question", () => {
    const hit = top("bgp peer setup");
    assert.ok(hit);
    assert.equal(hit.heading, "BGP");
  });

  it("respects the limit", () => {
    assert.ok(searchDocs(corpus, "print", { limit: 2 }).length <= 2);
  });
});

describe("mikrotik_search_docs", () => {
  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      createServer(sandbox().env).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  it("is exposed alongside the router tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["mikrotik_exec", "mikrotik_list_profiles", "mikrotik_search_docs"],
    );
  });

  it("returns ranked sections", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "mikrotik_search_docs",
      arguments: { query: "print detail output paging" },
    });
    const structured = result.structuredContent as { results: { heading: string }[] };
    assert.ok(structured.results.length > 0);
    assert.match((result.content as { text?: string }[])[0]?.text ?? "", /RouterOS v/);
  });

  it("lists available topics when nothing matches", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "mikrotik_search_docs",
      arguments: { query: "kubernetes helm chart" },
    });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    assert.match(text, /No reference section matches/);
    assert.match(text, /Available topics:/);
  });

  it("works without any router configured", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "mikrotik_search_docs",
      arguments: { query: "interface print" },
    });
    assert.notEqual(result.isError, true, "docs must not depend on config");
  });
});
