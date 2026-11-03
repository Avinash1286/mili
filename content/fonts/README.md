# PDF font

Noto Sans Regular and Noto Sans Math Regular are vendored unmodified from the official Noto repository at the commit pinned in `manifest.json`. The accompanying complete SIL Open Font License permits embedding and redistribution subject to its terms. The PDF renderer verifies both pinned font hashes before use and embeds subsets containing the document's glyphs. It supports Latin, Greek, Cyrillic, arrows, subscripts and mathematical symbols. Unsupported glyphs produce an explicit export error with Markdown/JSON alternatives, rather than silently losing the learner's text.

To reproduce the files, download the exact HTTPS asset URLs listed in the manifest and verify both byte counts and SHA-256 hashes. There is no runtime font download.
