---
name: deep-x-research
description: Deep, exhaustive research on a topic across X (Twitter) using the logged-in Chrome session via surf. Use when the user wants comprehensive X research on a concept, technique, trend, tool, or creator scene; needs categorized findings with every claim traceable to post URLs; or when a single search or Grok query is not enough.
---

# Deep X Research

Research a topic across X by sweeping it from multiple angles — keyword and semantic, Latest and Top — then deliver categorized findings where every claim is traceable to a post URL.

Requires: surf installed and connected (`surf doctor`), Chrome logged into x.com. Command reference: the `surf` skill or `surf --help`.

## Steps

### 1. Decompose the topic into a query set

Break the topic into exact phrases, synonyms, sub-techniques, adjacent tool names, and hashtags. When the topic is visual (editing, design, animation, AI video), add `filter:videos` variants. Done when you have **at least 6 distinct queries** that would each surface different posts.

### 2. Sweep

Run every query through both search modes, plus semantic passes through Grok:

```bash
# Keyword search — Latest and Top for each query (URL-encode the query)
surf navigate "https://x.com/search?q=QUERY&f=live"   # Latest
surf page.read --compact
surf navigate "https://x.com/search?q=QUERY&f=top"    # Top
surf page.read --compact
surf scroll down 2000    # then page.read again — repeat 2-3x to load more results

# Semantic search — at least 2 passes, one deep
surf grok "What are the best examples and discussions of TOPIC on X? Include post links."
surf grok "TOPIC: notable creators, techniques, and how it's evolving" --deep-search
```

Record every relevant post as you find it: author, one-line gist, full `https://x.com/USER/status/ID` URL. The sweep is done when it **runs dry**: a full round of new query variants adds no new relevant posts. If early rounds come back thin, widen the query set with more synonyms and related terms rather than stopping.

### 3. Video pass (visual topics)

When the topic involves video, editing, or visual style, analyze the strongest video posts — **at least 6** when the sweep surfaced that many:

- Primary: ask Grok about the post directly — `surf grok "Analyze the video in this post: URL — describe the techniques, pacing, and style"`.
- Fallback: open the post, click play, take 3-4 timed `surf screenshot` frames.
- Capture the direct video URL when available: `surf network` after playback and look for `video.twimg.com` entries.

Done when each analyzed video has notes on what it shows and why it matters for the topic.

### 4. Categorize and analyze

Group findings into categories that fit the topic — e.g. showcases, tutorials & techniques, tools, AI prompts, community discussion. Then extract trends: momentum on X, recurring techniques, notable creators, how the topic is evolving. Done when every recorded post is either placed in a category or deliberately dropped as irrelevant.

### 5. Report with full traceability

```md
# Deep Research on [Topic]

## Summary
[2-4 paragraphs: state of the topic on X]

## Key Trends
- ...

## Categorized Findings
### [Category]
- [Finding with inline post reference]

## Notable Creators & Techniques
- ...

## References
1. [Author — one-line description]
   https://x.com/USER/status/ID
   Video: https://video.twimg.com/... (when captured)
```

The report is done when **every post mentioned anywhere in it appears in References with its full URL** — no bare @handles, no "a viral post showed…" without a link.

## X Search Operators

Compose into the `q=` parameter (URL-encoded):

| Operator | Effect |
| --- | --- |
| `"exact phrase"` | Match phrase exactly |
| `filter:videos` / `filter:media` | Only posts with video / any media |
| `min_faves:100` / `min_retweets:50` | Engagement floor — use to surface quality in noisy topics |
| `from:user` / `to:user` | By author / replies to |
| `since:2026-01-01` / `until:2026-06-01` | Date range |
| `&f=live` / `&f=top` / `&f=user` | URL param: Latest / Top / People tab |

## Troubleshooting

- Search page shows a login wall → Chrome isn't logged into x.com; ask the user to log in.
- Grok queries fail → `surf grok --validate`, then retry with a model from the validation output (see the `surf` skill's AI troubleshooting section).
- Search results won't load more on scroll → X throttles; wait a few seconds (`surf wait 3`) and continue, or move to the next query.
